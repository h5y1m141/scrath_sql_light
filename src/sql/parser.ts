// ============================================================
// 型定義 — Statement, WHERE条件, カラム定義
// ============================================================

export type ColumnType = "INTEGER" | "TEXT";

export type ColumnConstraint = "PRIMARY_KEY" | "NOT_NULL" | "UNIQUE";

export type ColumnDef = {
  name: string;
  type: ColumnType;
  constraints: ColumnConstraint[];
};

export type WhereCondition = {
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=";
  value: string | number;
};

export type CreateTableStatement = {
  type: "CREATE_TABLE";
  tableName: string;
  columns: ColumnDef[];
};

export type InsertStatement = {
  type: "INSERT";
  tableName: string;
  columns: string[];
  values: (string | number)[];
};

export type SelectStatement = {
  type: "SELECT";
  tableName: string;
  columns: string[];
  where: Record<string, WhereCondition>;
};

export type Statement = CreateTableStatement | InsertStatement | SelectStatement;

export type ParseResult =
  | { success: true; statement: Statement }
  | { success: false; error: string };

// ============================================================
// パーサー本体
// ============================================================

export function parse(sql: string): ParseResult {
  const trimmed = removeComments(sql.trim());
  if (trimmed === "") {
    return { success: false, error: "Empty SQL statement" };
  }

  const upper = trimmed.toUpperCase();

  if (upper.startsWith("CREATE TABLE")) {
    return parseCreateTable(trimmed);
  }
  if (upper.startsWith("INSERT INTO")) {
    return parseInsert(trimmed);
  }
  if (upper.startsWith("SELECT")) {
    return parseSelect(trimmed);
  }

  return { success: false, error: "Unsupported SQL statement" };
}

// ============================================================
// コメント除去
// ============================================================

function removeComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx).trim() : line;
    })
    .filter((line) => line !== "")
    .join(" ");
}

// ============================================================
// CREATE TABLE パーサー
// ============================================================

function parseCreateTable(sql: string): ParseResult {
  // 改行をスペースに統一
  const normalized = sql.replace(/\n/g, " ");

  const match = normalized.match(
    /CREATE\s+TABLE\s+(\w+)\s*\((.*)\)/i,
  );
  if (!match) {
    return { success: false, error: "Invalid CREATE TABLE syntax" };
  }

  const tableName = match[1];
  const columnDefs = match[2].split(",");
  const columns: ColumnDef[] = [];

  for (const colDef of columnDefs) {
    const parts = colDef.trim().split(/\s+/);
    if (parts.length < 2) {
      return {
        success: false,
        error: `Invalid column definition: ${colDef.trim()}`,
      };
    }

    const colName = parts[0];
    const colType = parts[1].toUpperCase();

    if (colType !== "INTEGER" && colType !== "INT" && colType !== "TEXT") {
      return {
        success: false,
        error: `Unsupported column type: ${parts[1]}`,
      };
    }

    const normalizedType: ColumnType =
      colType === "INT" ? "INTEGER" : (colType as ColumnType);

    const constraints: ColumnConstraint[] = [];

    for (let i = 2; i < parts.length; i++) {
      const upper = parts[i].toUpperCase();
      if (upper === "PRIMARY" && parts[i + 1]?.toUpperCase() === "KEY") {
        constraints.push("PRIMARY_KEY");
        i++; // skip "KEY"
      } else if (upper === "NOT" && parts[i + 1]?.toUpperCase() === "NULL") {
        constraints.push("NOT_NULL");
        i++; // skip "NULL"
      } else if (upper === "UNIQUE") {
        constraints.push("UNIQUE");
      }
    }

    columns.push({ name: colName, type: normalizedType, constraints });
  }

  return {
    success: true,
    statement: { type: "CREATE_TABLE", tableName, columns },
  };
}

// ============================================================
// INSERT INTO パーサー
// ============================================================

function parseInsert(sql: string): ParseResult {
  const match = sql.match(
    /INSERT\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)/i,
  );
  if (!match) {
    return { success: false, error: "Invalid INSERT syntax" };
  }

  const tableName = match[1];
  const columns = match[2].split(",").map((c) => c.trim());
  const rawValues = match[3].split(",").map((v) => v.trim());

  const values: (string | number)[] = [];
  for (const raw of rawValues) {
    const parsed = parseValue(raw);
    if (parsed === null) {
      return { success: false, error: `Invalid value: ${raw}` };
    }
    values.push(parsed);
  }

  return {
    success: true,
    statement: { type: "INSERT", tableName, columns, values },
  };
}

// ============================================================
// SELECT パーサー
// ============================================================

function parseSelect(sql: string): ParseResult {
  // セミコロン除去
  const cleaned = sql.replace(/;\s*$/, "");

  const match = cleaned.match(
    /SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*))?/i,
  );
  if (!match) {
    return { success: false, error: "Invalid SELECT syntax" };
  }

  const columns = match[1].split(",").map((c) => c.trim());
  const tableName = match[2];
  const where: Record<string, WhereCondition> = {};

  if (match[3]) {
    const whereResult = parseWhereClause(match[3].trim());
    if (!whereResult.success) {
      return whereResult;
    }
    Object.assign(where, whereResult.conditions);
  }

  return {
    success: true,
    statement: { type: "SELECT", tableName, columns, where },
  };
}

// ============================================================
// WHERE 句パーサー
// ============================================================

type WhereParseResult =
  | { success: true; conditions: Record<string, WhereCondition> }
  | { success: false; error: string };

const OPERATORS = [">=", "<=", "!=", ">", "<", "="] as const;

function parseWhereClause(wherePart: string): WhereParseResult {
  const conditions: Record<string, WhereCondition> = {};

  // AND で分割 (大文字小文字無視)
  const parts = wherePart.split(/\s+AND\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();

    // 演算子を探す
    let foundOperator: (typeof OPERATORS)[number] | null = null;
    let operatorIndex = -1;

    for (const op of OPERATORS) {
      const idx = trimmed.indexOf(op);
      if (idx > 0) {
        foundOperator = op;
        operatorIndex = idx;
        break;
      }
    }

    if (!foundOperator || operatorIndex < 0) {
      return { success: false, error: `Invalid WHERE condition: ${trimmed}` };
    }

    const column = trimmed.slice(0, operatorIndex).trim();
    const rawValue = trimmed.slice(operatorIndex + foundOperator.length).trim();

    const value = parseValue(rawValue);
    if (value === null) {
      return { success: false, error: `Invalid value in WHERE: ${rawValue}` };
    }

    conditions[column] = { operator: foundOperator, value };
  }

  return { success: true, conditions };
}

// ============================================================
// 値パーサー (文字列 or 数値)
// ============================================================

function parseValue(raw: string): string | number | null {
  // シングルクォート文字列
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }

  // ダブルクォート文字列
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }

  // 整数
  const num = Number(raw);
  if (!Number.isNaN(num) && Number.isInteger(num)) {
    return num;
  }

  return null;
}
