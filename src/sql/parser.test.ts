import { describe, test, expect } from "bun:test";
import { parse } from "./parser.ts";
import type {
  CreateTableStatement,
  InsertStatement,
  SelectStatement,
} from "./parser.ts";

// ============================================================
// CREATE TABLE
// ============================================================

describe("CREATE TABLE", () => {
  test("基本的なテーブル作成", () => {
    const result = parse("CREATE TABLE users (id INTEGER, name TEXT);");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.type).toBe("CREATE_TABLE");
    expect(stmt.tableName).toBe("users");
    expect(stmt.columns).toEqual([
      { name: "id", type: "INTEGER", constraints: [] },
      { name: "name", type: "TEXT", constraints: [] },
    ]);
  });

  test("INT は INTEGER に正規化される", () => {
    const result = parse("CREATE TABLE t (id INT);");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.columns[0].type).toBe("INTEGER");
  });

  test("PRIMARY KEY 制約", () => {
    const result = parse(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.columns[0].constraints).toContain("PRIMARY_KEY");
  });

  test("NOT NULL 制約", () => {
    const result = parse(
      "CREATE TABLE users (id INTEGER, name TEXT NOT NULL);",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.columns[1].constraints).toContain("NOT_NULL");
  });

  test("UNIQUE 制約", () => {
    const result = parse(
      "CREATE TABLE users (id INTEGER, email TEXT UNIQUE);",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.columns[1].constraints).toContain("UNIQUE");
  });

  test("複数制約の組み合わせ", () => {
    const result = parse(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.columns[0].constraints).toEqual(["PRIMARY_KEY"]);
    expect(stmt.columns[1].constraints).toEqual(["NOT_NULL"]);
    expect(stmt.columns[2].constraints).toEqual(["UNIQUE"]);
  });

  test("複数行のCREATE TABLE", () => {
    const sql = `CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE
    );`;
    const result = parse(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as CreateTableStatement;
    expect(stmt.columns).toHaveLength(3);
  });

  test("不正な構文でエラー", () => {
    const result = parse("CREATE TABLE;");
    expect(result.success).toBe(false);
  });

  test("カラム定義がない場合エラー", () => {
    const result = parse("CREATE TABLE users (id);");
    expect(result.success).toBe(false);
  });
});

// ============================================================
// INSERT INTO
// ============================================================

describe("INSERT INTO", () => {
  test("整数値のINSERT", () => {
    const result = parse(
      "INSERT INTO users (id, name) VALUES (1, 'Alice');",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as InsertStatement;
    expect(stmt.type).toBe("INSERT");
    expect(stmt.tableName).toBe("users");
    expect(stmt.columns).toEqual(["id", "name"]);
    expect(stmt.values).toEqual([1, "Alice"]);
  });

  test("文字列値（シングルクォート）", () => {
    const result = parse(
      "INSERT INTO users (name) VALUES ('Bob');",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as InsertStatement;
    expect(stmt.values).toEqual(["Bob"]);
  });

  test("複数カラムと値", () => {
    const result = parse(
      "INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as InsertStatement;
    expect(stmt.columns).toHaveLength(3);
    expect(stmt.values).toHaveLength(3);
    expect(stmt.values[0]).toBe(1);
    expect(stmt.values[1]).toBe("Alice");
    expect(stmt.values[2]).toBe("alice@example.com");
  });

  test("不正な構文でエラー", () => {
    const result = parse("INSERT INTO;");
    expect(result.success).toBe(false);
  });
});

// ============================================================
// SELECT
// ============================================================

describe("SELECT", () => {
  test("SELECT *", () => {
    const result = parse("SELECT * FROM users;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.type).toBe("SELECT");
    expect(stmt.tableName).toBe("users");
    expect(stmt.columns).toEqual(["*"]);
    expect(Object.keys(stmt.where)).toHaveLength(0);
  });

  test("特定カラムの指定", () => {
    const result = parse("SELECT id, name FROM users;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.columns).toEqual(["id", "name"]);
  });

  test("WHERE 条件 (=)", () => {
    const result = parse("SELECT * FROM users WHERE id = 1;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.where["id"]).toEqual({ operator: "=", value: 1 });
  });

  test("WHERE 条件 (文字列値)", () => {
    const result = parse("SELECT * FROM users WHERE name = 'Alice';");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.where["name"]).toEqual({ operator: "=", value: "Alice" });
  });

  test("WHERE 条件 (>)", () => {
    const result = parse("SELECT * FROM users WHERE id > 5;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.where["id"]).toEqual({ operator: ">", value: 5 });
  });

  test("WHERE 条件 (>=)", () => {
    const result = parse("SELECT * FROM users WHERE id >= 5;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.where["id"]).toEqual({ operator: ">=", value: 5 });
  });

  test("WHERE 条件 (!=)", () => {
    const result = parse("SELECT * FROM users WHERE id != 3;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.where["id"]).toEqual({ operator: "!=", value: 3 });
  });

  test("複数AND条件", () => {
    const result = parse(
      "SELECT * FROM users WHERE id > 0 AND name = 'Alice';",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.where["id"]).toEqual({ operator: ">", value: 0 });
    expect(stmt.where["name"]).toEqual({ operator: "=", value: "Alice" });
  });

  test("セミコロンなしでも動作", () => {
    const result = parse("SELECT * FROM users");
    expect(result.success).toBe(true);
  });

  test("不正な構文でエラー", () => {
    const result = parse("SELECT;");
    expect(result.success).toBe(false);
  });
});

// ============================================================
// 共通エラーケース
// ============================================================

describe("共通エラーケース", () => {
  test("空文字列", () => {
    const result = parse("");
    expect(result.success).toBe(false);
  });

  test("未対応のSQL文", () => {
    const result = parse("DROP TABLE users;");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Unsupported SQL statement");
    }
  });

  test("コメントのみ", () => {
    const result = parse("-- this is a comment");
    expect(result.success).toBe(false);
  });

  test("コメント付きSQL", () => {
    const sql = `-- Create users table
SELECT * FROM users;`;
    const result = parse(sql);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const stmt = result.statement as SelectStatement;
    expect(stmt.tableName).toBe("users");
  });
});
