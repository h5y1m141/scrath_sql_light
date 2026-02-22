import { describe, test, expect } from "bun:test";
import { Lexer } from "./lexer.ts";
import { TokenType } from "./token.ts";

// ============================================================
// SELECT 文のトークン化
// ============================================================

describe("Lexer: SELECT", () => {
  test("SELECT * FROM users", () => {
    const lexer = new Lexer("SELECT * FROM users");
    const expected = [
      { type: TokenType.SELECT, literal: "SELECT" },
      { type: TokenType.ASTERISK, literal: "*" },
      { type: TokenType.FROM, literal: "FROM" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });

  test("SELECT id, name FROM users", () => {
    const lexer = new Lexer("SELECT id, name FROM users");
    const expected = [
      { type: TokenType.SELECT, literal: "SELECT" },
      { type: TokenType.IDENT, literal: "id" },
      { type: TokenType.COMMA, literal: "," },
      { type: TokenType.IDENT, literal: "name" },
      { type: TokenType.FROM, literal: "FROM" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });

  test("WHERE 句付き SELECT", () => {
    const lexer = new Lexer("SELECT * FROM users WHERE id = 1;");
    const expected = [
      { type: TokenType.SELECT, literal: "SELECT" },
      { type: TokenType.ASTERISK, literal: "*" },
      { type: TokenType.FROM, literal: "FROM" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.WHERE, literal: "WHERE" },
      { type: TokenType.IDENT, literal: "id" },
      { type: TokenType.EQ, literal: "=" },
      { type: TokenType.NUMBER, literal: "1" },
      { type: TokenType.SEMICOLON, literal: ";" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });
});

// ============================================================
// CREATE TABLE 文のトークン化
// ============================================================

describe("Lexer: CREATE TABLE", () => {
  test("基本的な CREATE TABLE", () => {
    const lexer = new Lexer("CREATE TABLE users (id INTEGER, name TEXT);");
    const expected = [
      { type: TokenType.CREATE, literal: "CREATE" },
      { type: TokenType.TABLE, literal: "TABLE" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.LPAREN, literal: "(" },
      { type: TokenType.IDENT, literal: "id" },
      { type: TokenType.INTEGER_KW, literal: "INTEGER" },
      { type: TokenType.COMMA, literal: "," },
      { type: TokenType.IDENT, literal: "name" },
      { type: TokenType.TEXT_KW, literal: "TEXT" },
      { type: TokenType.RPAREN, literal: ")" },
      { type: TokenType.SEMICOLON, literal: ";" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });

  test("制約付き CREATE TABLE", () => {
    const lexer = new Lexer(
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    );
    const expected = [
      { type: TokenType.CREATE, literal: "CREATE" },
      { type: TokenType.TABLE, literal: "TABLE" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.LPAREN, literal: "(" },
      { type: TokenType.IDENT, literal: "id" },
      { type: TokenType.INTEGER_KW, literal: "INTEGER" },
      { type: TokenType.PRIMARY, literal: "PRIMARY" },
      { type: TokenType.KEY, literal: "KEY" },
      { type: TokenType.COMMA, literal: "," },
      { type: TokenType.IDENT, literal: "name" },
      { type: TokenType.TEXT_KW, literal: "TEXT" },
      { type: TokenType.NOT, literal: "NOT" },
      { type: TokenType.NULL_KW, literal: "NULL" },
      { type: TokenType.RPAREN, literal: ")" },
      { type: TokenType.SEMICOLON, literal: ";" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });
});

// ============================================================
// INSERT INTO 文のトークン化
// ============================================================

describe("Lexer: INSERT INTO", () => {
  test("基本的な INSERT", () => {
    const lexer = new Lexer(
      "INSERT INTO users (id, name) VALUES (1, 'Alice');",
    );
    const expected = [
      { type: TokenType.INSERT, literal: "INSERT" },
      { type: TokenType.INTO, literal: "INTO" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.LPAREN, literal: "(" },
      { type: TokenType.IDENT, literal: "id" },
      { type: TokenType.COMMA, literal: "," },
      { type: TokenType.IDENT, literal: "name" },
      { type: TokenType.RPAREN, literal: ")" },
      { type: TokenType.VALUES, literal: "VALUES" },
      { type: TokenType.LPAREN, literal: "(" },
      { type: TokenType.NUMBER, literal: "1" },
      { type: TokenType.COMMA, literal: "," },
      { type: TokenType.STRING, literal: "Alice" },
      { type: TokenType.RPAREN, literal: ")" },
      { type: TokenType.SEMICOLON, literal: ";" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });
});

// ============================================================
// 演算子
// ============================================================

describe("Lexer: 演算子", () => {
  test("比較演算子", () => {
    const lexer = new Lexer("= != > < >= <=");
    const expected = [
      { type: TokenType.EQ, literal: "=" },
      { type: TokenType.NEQ, literal: "!=" },
      { type: TokenType.GT, literal: ">" },
      { type: TokenType.LT, literal: "<" },
      { type: TokenType.GTE, literal: ">=" },
      { type: TokenType.LTE, literal: "<=" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });
});

// ============================================================
// 文字列リテラル
// ============================================================

describe("Lexer: 文字列リテラル", () => {
  test("シングルクォート", () => {
    const lexer = new Lexer("'hello world'");
    const token = lexer.nextToken();
    expect(token.type).toBe(TokenType.STRING);
    expect(token.literal).toBe("hello world");
  });

  test("ダブルクォート", () => {
    const lexer = new Lexer('"hello world"');
    const token = lexer.nextToken();
    expect(token.type).toBe(TokenType.STRING);
    expect(token.literal).toBe("hello world");
  });
});

// ============================================================
// コメント
// ============================================================

describe("Lexer: コメント", () => {
  test("行コメントをスキップ", () => {
    const lexer = new Lexer("-- this is a comment\nSELECT *");
    const expected = [
      { type: TokenType.SELECT, literal: "SELECT" },
      { type: TokenType.ASTERISK, literal: "*" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });

  test("コメントのみ", () => {
    const lexer = new Lexer("-- only comment");
    const token = lexer.nextToken();
    expect(token.type).toBe(TokenType.EOF);
  });
});

// ============================================================
// 大文字小文字
// ============================================================

describe("Lexer: 大文字小文字", () => {
  test("小文字のキーワードも認識", () => {
    const lexer = new Lexer("select * from users");
    const expected = [
      { type: TokenType.SELECT, literal: "select" },
      { type: TokenType.ASTERISK, literal: "*" },
      { type: TokenType.FROM, literal: "from" },
      { type: TokenType.IDENT, literal: "users" },
      { type: TokenType.EOF, literal: "" },
    ];
    for (const e of expected) {
      const token = lexer.nextToken();
      expect(token.type).toBe(e.type);
      expect(token.literal).toBe(e.literal);
    }
  });
});
