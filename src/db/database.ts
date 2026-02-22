import { Pager, PAGE_TYPE } from "../storage/pager.ts";
import { BTree } from "./btree.ts";
import type { ColumnValue } from "./btree.ts";
import type {
  Statement,
  CreateTableStatement,
  InsertStatement,
  SelectStatement,
  ColumnDef,
} from "../sql/parser.ts";

// ============================================================
// 型定義
// ============================================================

export type Record = {
  [columnName: string]: ColumnValue;
};

export type QueryResult =
  | { success: true; message: string; columns?: string[]; records?: Record[] }
  | { success: false; error: string };

/** スキーマ上のテーブル情報 */
type TableSchema = {
  name: string;
  columns: ColumnDef[];
  rootPageNum: number;
};

// ============================================================
// スキーマページのシリアライズ形式
//
// [0]      u8   ページタイプ (0x01 = Schema)
// [1..2]   u16  テーブル数
// [3..]    テーブルエントリの配列:
//   - テーブル名: u16(長さ) + UTF-8
//   - カラム数: u16
//   - カラム定義の配列:
//     - カラム名: u16(長さ) + UTF-8
//     - 型: u8 (0x01=INTEGER, 0x02=TEXT)
//     - 制約フラグ: u8 (bit0=PRIMARY_KEY, bit1=NOT_NULL, bit2=UNIQUE)
//   - ルートページ番号: u32
// ============================================================

const COLUMN_TYPE_MAP: { [key: string]: number } = {
  INTEGER: 0x01,
  TEXT: 0x02,
};

const COLUMN_TYPE_REVERSE: { [key: number]: "INTEGER" | "TEXT" } = {
  0x01: "INTEGER",
  0x02: "TEXT",
};

// ============================================================
// Database クラス
// ============================================================

export class Database {
  private pager: Pager;
  private tables: Map<string, TableSchema> = new Map();
  private btrees: Map<string, BTree> = new Map();

  private constructor(pager: Pager) {
    this.pager = pager;
  }

  /**
   * データベースを開く（なければ新規作成）
   */
  static open(filePath: string): QueryResult & { db?: Database } {
    const pagerResult = Pager.open(filePath);
    if (!pagerResult.success) {
      return { success: false, error: pagerResult.error };
    }

    const db = new Database(pagerResult.data);

    // スキーマページからテーブル情報を読み込む
    const loadResult = db.loadSchema();
    if (!loadResult.success) {
      pagerResult.data.close();
      return loadResult;
    }

    return { success: true, message: "Database opened", db };
  }

  /**
   * Statement を実行する
   */
  execute(stmt: Statement): QueryResult {
    switch (stmt.type) {
      case "CREATE_TABLE":
        return this.executeCreate(stmt);
      case "INSERT":
        return this.executeInsert(stmt);
      case "SELECT":
        return this.executeSelect(stmt);
      default:
        return { success: false, error: `Unsupported statement type: ${(stmt as Statement).type}` };
    }
  }

  /**
   * データベースを閉じる
   */
  close(): void {
    this.pager.close();
  }

  // ============================================================
  // CREATE TABLE
  // ============================================================

  private executeCreate(stmt: CreateTableStatement): QueryResult {
    const tableName = stmt.tableName.toLowerCase();

    if (this.tables.has(tableName)) {
      return { success: false, error: `Table '${stmt.tableName}' already exists` };
    }

    // PRIMARY KEY は最大1つ
    const pkCount = stmt.columns.filter((c) =>
      c.constraints.includes("PRIMARY_KEY"),
    ).length;
    if (pkCount > 1) {
      return { success: false, error: "Table can only have one PRIMARY KEY" };
    }

    // B+Tree を作成
    const treeResult = BTree.create(this.pager);
    if (!treeResult.success) {
      return { success: false, error: treeResult.error };
    }

    const tree = treeResult.data;
    const schema: TableSchema = {
      name: stmt.tableName,
      columns: stmt.columns,
      rootPageNum: tree.getRootPageNum(),
    };

    this.tables.set(tableName, schema);
    this.btrees.set(tableName, tree);

    // スキーマページを更新
    const saveResult = this.saveSchema();
    if (!saveResult.success) return saveResult;

    return { success: true, message: `Table '${stmt.tableName}' created` };
  }

  // ============================================================
  // INSERT INTO
  // ============================================================

  private executeInsert(stmt: InsertStatement): QueryResult {
    const tableName = stmt.tableName.toLowerCase();
    const schema = this.tables.get(tableName);
    if (!schema) {
      return { success: false, error: `Table '${stmt.tableName}' does not exist` };
    }

    const tree = this.btrees.get(tableName);
    if (!tree) {
      return { success: false, error: `B+Tree not found for table '${stmt.tableName}'` };
    }

    // カラム数と値の数が一致するか
    if (stmt.columns.length !== stmt.values.length) {
      return {
        success: false,
        error: `Column count (${stmt.columns.length}) does not match value count (${stmt.values.length})`,
      };
    }

    // カラム名を検証し、値を組み立てる
    const columnMap = new Map<string, number>();
    for (let i = 0; i < schema.columns.length; i++) {
      columnMap.set(schema.columns[i].name.toLowerCase(), i);
    }

    // スキーマ順の値配列を作る (未指定カラムは null)
    const values: ColumnValue[] = new Array(schema.columns.length).fill(null);
    let keyValue: number | null = null;

    for (let i = 0; i < stmt.columns.length; i++) {
      const colIdx = columnMap.get(stmt.columns[i].toLowerCase());
      if (colIdx === undefined) {
        return { success: false, error: `Column '${stmt.columns[i]}' does not exist in table '${stmt.tableName}'` };
      }

      const colDef = schema.columns[colIdx];
      const rawValue = stmt.values[i];

      // 型チェックと変換
      const converted = convertValue(colDef, rawValue);
      if (!converted.success) return converted;
      values[colIdx] = converted.value;

      // PRIMARY KEY カラムからキーを取得
      if (colDef.constraints.includes("PRIMARY_KEY")) {
        if (typeof converted.value !== "number") {
          return { success: false, error: `PRIMARY KEY column '${colDef.name}' must be INTEGER` };
        }
        keyValue = converted.value;
      }
    }

    // NOT NULL チェック
    for (let i = 0; i < schema.columns.length; i++) {
      const colDef = schema.columns[i];
      if (colDef.constraints.includes("NOT_NULL") && values[i] === null) {
        return { success: false, error: `Column '${colDef.name}' cannot be null` };
      }
    }

    // PRIMARY KEY がない場合は auto-increment 的に連番を生成
    if (keyValue === null) {
      const scanResult = tree.scan();
      if (!scanResult.success) {
        return { success: false, error: scanResult.error };
      }
      keyValue = scanResult.data.length > 0
        ? Math.max(...scanResult.data.map((r) => r.key)) + 1
        : 1;
    }

    // B+Tree に挿入
    const insertResult = tree.insert({ key: keyValue, values });
    if (!insertResult.success) {
      if (insertResult.error.includes("Duplicate key")) {
        return { success: false, error: `Duplicate PRIMARY KEY value: ${keyValue}` };
      }
      return { success: false, error: insertResult.error };
    }

    // ルートページが変わった可能性があるのでスキーマを更新
    const currentSchema = this.tables.get(tableName)!;
    if (currentSchema.rootPageNum !== tree.getRootPageNum()) {
      currentSchema.rootPageNum = tree.getRootPageNum();
      this.saveSchema();
    }

    return { success: true, message: "1 row inserted" };
  }

  // ============================================================
  // SELECT
  // ============================================================

  private executeSelect(stmt: SelectStatement): QueryResult {
    const tableName = stmt.tableName.toLowerCase();
    const schema = this.tables.get(tableName);
    if (!schema) {
      return { success: false, error: `Table '${stmt.tableName}' does not exist` };
    }

    const tree = this.btrees.get(tableName);
    if (!tree) {
      return { success: false, error: `B+Tree not found for table '${stmt.tableName}'` };
    }

    // 全レコードを取得
    const scanResult = tree.scan();
    if (!scanResult.success) {
      return { success: false, error: scanResult.error };
    }

    // カラム名リストを決定
    const allColumnNames = schema.columns.map((c) => c.name);
    const isSelectAll = stmt.columns.length === 1 && stmt.columns[0] === "*";

    const selectedColumns: string[] = isSelectAll
      ? allColumnNames
      : stmt.columns.map((col) => {
          // 大文字小文字を無視してマッチ
          const found = allColumnNames.find(
            (c) => c.toLowerCase() === col.toLowerCase(),
          );
          return found ?? col;
        });

    // 存在しないカラムのチェック
    if (!isSelectAll) {
      for (const col of selectedColumns) {
        if (!allColumnNames.find((c) => c.toLowerCase() === col.toLowerCase())) {
          return { success: false, error: `Column '${col}' does not exist in table '${stmt.tableName}'` };
        }
      }
    }

    // B+Tree のレコードを Record 形式に変換
    let records: Record[] = scanResult.data.map((btreeRecord) => {
      const record: Record = {};
      for (let i = 0; i < allColumnNames.length; i++) {
        record[allColumnNames[i]] = btreeRecord.values[i] ?? null;
      }
      return record;
    });

    // WHERE フィルタリング
    if (Object.keys(stmt.where).length > 0) {
      records = records.filter((record) => {
        for (const [col, condition] of Object.entries(stmt.where)) {
          const actualCol = allColumnNames.find(
            (c) => c.toLowerCase() === col.toLowerCase(),
          );
          if (!actualCol) return false;

          const recordValue = record[actualCol];
          if (!matchesCondition(recordValue, condition.operator, condition.value)) {
            return false;
          }
        }
        return true;
      });
    }

    // 指定カラムだけに絞る
    const projectedRecords = records.map((record) => {
      const projected: Record = {};
      for (const col of selectedColumns) {
        projected[col] = record[col] ?? null;
      }
      return projected;
    });

    return {
      success: true,
      message: `${projectedRecords.length} row(s) found`,
      columns: selectedColumns,
      records: projectedRecords,
    };
  }

  // ============================================================
  // スキーマ読み書き
  // ============================================================

  private loadSchema(): QueryResult {
    const header = this.pager.getHeader();
    const readResult = this.pager.readPage(header.schemaPage);
    if (!readResult.success) {
      return { success: false, error: readResult.error };
    }

    const page = readResult.data;
    const tableCount = page.readUInt16LE(1);
    let offset = 3;

    for (let i = 0; i < tableCount; i++) {
      // テーブル名
      const nameLen = page.readUInt16LE(offset);
      offset += 2;
      const name = page.toString("utf-8", offset, offset + nameLen);
      offset += nameLen;

      // カラム数
      const colCount = page.readUInt16LE(offset);
      offset += 2;

      const columns: ColumnDef[] = [];
      for (let j = 0; j < colCount; j++) {
        // カラム名
        const colNameLen = page.readUInt16LE(offset);
        offset += 2;
        const colName = page.toString("utf-8", offset, offset + colNameLen);
        offset += colNameLen;

        // 型
        const typeTag = page.readUInt8(offset);
        offset += 1;
        const colType = COLUMN_TYPE_REVERSE[typeTag] ?? "TEXT";

        // 制約フラグ
        const constraintFlags = page.readUInt8(offset);
        offset += 1;
        const constraints: ColumnDef["constraints"] = [];
        if (constraintFlags & 0x01) constraints.push("PRIMARY_KEY");
        if (constraintFlags & 0x02) constraints.push("NOT_NULL");
        if (constraintFlags & 0x04) constraints.push("UNIQUE");

        columns.push({ name: colName, type: colType, constraints });
      }

      // ルートページ番号
      const rootPageNum = page.readUInt32LE(offset);
      offset += 4;

      const tableLower = name.toLowerCase();
      this.tables.set(tableLower, { name, columns, rootPageNum });
      this.btrees.set(tableLower, BTree.open(this.pager, rootPageNum));
    }

    return { success: true, message: "Schema loaded" };
  }

  private saveSchema(): QueryResult {
    const header = this.pager.getHeader();
    const page = Buffer.alloc(this.pager.getPageSize(), 0);

    page.writeUInt8(PAGE_TYPE.SCHEMA, 0);
    page.writeUInt16LE(this.tables.size, 1);

    let offset = 3;

    for (const schema of this.tables.values()) {
      // テーブル名
      const nameBuf = Buffer.from(schema.name, "utf-8");
      page.writeUInt16LE(nameBuf.length, offset);
      offset += 2;
      nameBuf.copy(page, offset);
      offset += nameBuf.length;

      // カラム数
      page.writeUInt16LE(schema.columns.length, offset);
      offset += 2;

      for (const col of schema.columns) {
        // カラム名
        const colNameBuf = Buffer.from(col.name, "utf-8");
        page.writeUInt16LE(colNameBuf.length, offset);
        offset += 2;
        colNameBuf.copy(page, offset);
        offset += colNameBuf.length;

        // 型
        page.writeUInt8(COLUMN_TYPE_MAP[col.type] ?? 0x02, offset);
        offset += 1;

        // 制約フラグ
        let flags = 0;
        if (col.constraints.includes("PRIMARY_KEY")) flags |= 0x01;
        if (col.constraints.includes("NOT_NULL")) flags |= 0x02;
        if (col.constraints.includes("UNIQUE")) flags |= 0x04;
        page.writeUInt8(flags, offset);
        offset += 1;
      }

      // ルートページ番号
      page.writeUInt32LE(schema.rootPageNum, offset);
      offset += 4;
    }

    const writeResult = this.pager.writePage(header.schemaPage, page);
    if (!writeResult.success) {
      return { success: false, error: writeResult.error };
    }

    return { success: true, message: "Schema saved" };
  }
}

// ============================================================
// ヘルパー関数
// ============================================================

function convertValue(
  colDef: ColumnDef,
  raw: string | number,
): { success: true; value: ColumnValue } | { success: false; error: string } {
  if (colDef.type === "INTEGER") {
    if (typeof raw === "number") {
      return { success: true, value: raw };
    }
    const num = Number(raw);
    if (Number.isNaN(num) || !Number.isInteger(num)) {
      return { success: false, error: `Invalid INTEGER value for column '${colDef.name}': ${raw}` };
    }
    return { success: true, value: num };
  }

  // TEXT
  return { success: true, value: String(raw) };
}

function matchesCondition(
  recordValue: ColumnValue,
  operator: string,
  conditionValue: string | number,
): boolean {
  if (recordValue === null) {
    return false;
  }

  // 型を揃える
  let a: number | string = recordValue as number | string;
  let b: number | string = conditionValue;

  // 両方数値に変換可能なら数値比較
  if (typeof a === "number" && typeof b === "string") {
    const bNum = Number(b);
    if (!Number.isNaN(bNum)) b = bNum;
  }
  if (typeof a === "string" && typeof b === "number") {
    const aNum = Number(a);
    if (!Number.isNaN(aNum)) a = aNum;
  }

  switch (operator) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    default:
      return false;
  }
}
