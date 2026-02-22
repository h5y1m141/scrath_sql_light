import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "./database.ts";
import { parse } from "../sql/parser.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/test_database.db";

afterEach(() => {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
});

/** SQL文を実行するヘルパー */
function exec(db: Database, sql: string) {
  const parsed = parse(sql);
  if (!parsed.success) throw new Error(parsed.error);
  return db.execute(parsed.statement);
}

function openDb(): Database {
  const result = Database.open(TEST_DB);
  if (!result.success || !result.db) throw new Error(result.error);
  return result.db;
}

// ============================================================
// CREATE TABLE
// ============================================================

describe("CREATE TABLE", () => {
  test("テーブルが作成される", () => {
    const db = openDb();
    const result = exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message).toContain("created");
    }
    db.close();
  });

  test("重複テーブル作成でエラー", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER);");
    const result = exec(db, "CREATE TABLE users (id INTEGER);");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("already exists");
    }
    db.close();
  });

  test("複数テーブルを作成できる", () => {
    const db = openDb();
    const r1 = exec(db, "CREATE TABLE users (id INTEGER, name TEXT);");
    const r2 = exec(db, "CREATE TABLE posts (id INTEGER, title TEXT);");
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    db.close();
  });
});

// ============================================================
// INSERT INTO
// ============================================================

describe("INSERT INTO", () => {
  test("レコードが格納される", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    const result = exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message).toContain("1 row inserted");
    }
    db.close();
  });

  test("存在しないテーブルへの INSERT でエラー", () => {
    const db = openDb();
    const result = exec(db, "INSERT INTO nonexistent (id) VALUES (1);");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("does not exist");
    }
    db.close();
  });

  test("存在しないカラムへの INSERT でエラー", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER, name TEXT);");
    const result = exec(db, "INSERT INTO users (id, age) VALUES (1, 25);");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("does not exist");
    }
    db.close();
  });

  test("NOT NULL カラムに値を指定しないとエラー", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);");
    const result = exec(db, "INSERT INTO users (id) VALUES (1);");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("cannot be null");
    }
    db.close();
  });

  test("重複 PRIMARY KEY でエラー", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    const result = exec(db, "INSERT INTO users (id, name) VALUES (1, 'Bob');");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Duplicate PRIMARY KEY");
    }
    db.close();
  });

  test("複数レコードの INSERT", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db, "INSERT INTO users (id, name) VALUES (2, 'Bob');");
    exec(db, "INSERT INTO users (id, name) VALUES (3, 'Charlie');");

    const result = exec(db, "SELECT * FROM users;");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.records).toHaveLength(3);
    }
    db.close();
  });
});

// ============================================================
// SELECT
// ============================================================

describe("SELECT", () => {
  test("SELECT * で全レコードが返る", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db, "INSERT INTO users (id, name) VALUES (2, 'Bob');");

    const result = exec(db, "SELECT * FROM users;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.columns).toEqual(["id", "name"]);
    expect(result.records).toHaveLength(2);
    expect(result.records![0]).toEqual({ id: 1, name: "Alice" });
    expect(result.records![1]).toEqual({ id: 2, name: "Bob" });
    db.close();
  });

  test("特定カラムの SELECT", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);");
    exec(db, "INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');");

    const result = exec(db, "SELECT name FROM users;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.columns).toEqual(["name"]);
    expect(result.records![0]).toEqual({ name: "Alice" });
    db.close();
  });

  test("WHERE 条件 (=) で絞り込み", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db, "INSERT INTO users (id, name) VALUES (2, 'Bob');");
    exec(db, "INSERT INTO users (id, name) VALUES (3, 'Charlie');");

    const result = exec(db, "SELECT * FROM users WHERE id = 2;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.records).toHaveLength(1);
    expect(result.records![0]).toEqual({ id: 2, name: "Bob" });
    db.close();
  });

  test("WHERE 条件 (>) で絞り込み", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db, "INSERT INTO users (id, name) VALUES (2, 'Bob');");
    exec(db, "INSERT INTO users (id, name) VALUES (3, 'Charlie');");

    const result = exec(db, "SELECT * FROM users WHERE id > 1;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.records).toHaveLength(2);
    expect(result.records![0]).toEqual({ id: 2, name: "Bob" });
    expect(result.records![1]).toEqual({ id: 3, name: "Charlie" });
    db.close();
  });

  test("WHERE 文字列条件", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db, "INSERT INTO users (id, name) VALUES (2, 'Bob');");

    const result = exec(db, "SELECT * FROM users WHERE name = 'Alice';");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.records).toHaveLength(1);
    expect(result.records![0].name).toBe("Alice");
    db.close();
  });

  test("WHERE 複数条件 (AND)", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db, "INSERT INTO users (id, name) VALUES (2, 'Bob');");
    exec(db, "INSERT INTO users (id, name) VALUES (3, 'Alice');");

    const result = exec(db, "SELECT * FROM users WHERE id > 1 AND name = 'Alice';");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.records).toHaveLength(1);
    expect(result.records![0]).toEqual({ id: 3, name: "Alice" });
    db.close();
  });

  test("存在しないテーブルの SELECT でエラー", () => {
    const db = openDb();
    const result = exec(db, "SELECT * FROM nonexistent;");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("does not exist");
    }
    db.close();
  });

  test("空テーブルの SELECT", () => {
    const db = openDb();
    exec(db, "CREATE TABLE users (id INTEGER, name TEXT);");
    const result = exec(db, "SELECT * FROM users;");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.records).toHaveLength(0);
    }
    db.close();
  });
});

// ============================================================
// 永続化 (DB再起動)
// ============================================================

describe("永続化", () => {
  test("DB再起動後もデータが残る", () => {
    // データを書き込んで閉じる
    const db1 = openDb();
    exec(db1, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db1, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db1, "INSERT INTO users (id, name) VALUES (2, 'Bob');");
    db1.close();

    // 再オープン
    const db2 = openDb();
    const result = exec(db2, "SELECT * FROM users;");
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.records).toHaveLength(2);
    expect(result.records![0]).toEqual({ id: 1, name: "Alice" });
    expect(result.records![1]).toEqual({ id: 2, name: "Bob" });
    db2.close();
  });

  test("DB再起動後もスキーマ(複数テーブル)が残る", () => {
    const db1 = openDb();
    exec(db1, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db1, "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT);");
    exec(db1, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    exec(db1, "INSERT INTO posts (id, title) VALUES (1, 'Hello');");
    db1.close();

    const db2 = openDb();
    const usersResult = exec(db2, "SELECT * FROM users;");
    const postsResult = exec(db2, "SELECT * FROM posts;");
    expect(usersResult.success).toBe(true);
    expect(postsResult.success).toBe(true);
    if (usersResult.success) expect(usersResult.records).toHaveLength(1);
    if (postsResult.success) expect(postsResult.records).toHaveLength(1);
    db2.close();
  });

  test("DB再起動後にデータ追加できる", () => {
    const db1 = openDb();
    exec(db1, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
    exec(db1, "INSERT INTO users (id, name) VALUES (1, 'Alice');");
    db1.close();

    const db2 = openDb();
    exec(db2, "INSERT INTO users (id, name) VALUES (2, 'Bob');");
    const result = exec(db2, "SELECT * FROM users;");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.records).toHaveLength(2);
    }
    db2.close();
  });
});
