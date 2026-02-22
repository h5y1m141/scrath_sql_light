import { Lexer } from "./lexer.ts";
import { Token, TokenType } from "./token.ts";

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
  const parser = new SqlParser(sql);
  return parser.parse();
}

// ============================================================
// SqlParser クラス（内部用）
// ============================================================

class SqlParser {
  private lexer: Lexer;
  private currentToken!: Token;
  private peekToken!: Token;

  constructor(input: string) {
    this.lexer = new Lexer(input);
    // currentToken と peekToken の両方をセット
    this.nextToken();
    this.nextToken();
  }

  // ============================================================
  // トークン操作ヘルパー
  // ============================================================

  private nextToken(): void {
    this.currentToken = this.peekToken;
    this.peekToken = this.lexer.nextToken();
  }

  private curTokenIs(type: TokenType): boolean {
    return this.currentToken.type === type;
  }

  private peekTokenIs(type: TokenType): boolean {
    return this.peekToken.type === type;
  }

  private expectPeek(type: TokenType): boolean {
    if (this.peekTokenIs(type)) {
      this.nextToken();
      return true;
    }
    return false;
  }

  // ============================================================
  // メインの解析
  // ============================================================

  parse(): ParseResult {
    if (this.curTokenIs(TokenType.EOF)) {
      return { success: false, error: "Empty SQL statement" };
    }

    if (this.curTokenIs(TokenType.CREATE)) {
      return this.parseCreateTable();
    }
    if (this.curTokenIs(TokenType.INSERT)) {
      return this.parseInsert();
    }
    if (this.curTokenIs(TokenType.SELECT)) {
      return this.parseSelect();
    }

    return { success: false, error: "Unsupported SQL statement" };
  }

  // ============================================================
  // CREATE TABLE パーサー
  // ============================================================

  private parseCreateTable(): ParseResult {
    // CREATE TABLE <tableName> (
    if (!this.expectPeek(TokenType.TABLE)) {
      return { success: false, error: "Invalid CREATE TABLE syntax" };
    }
    if (!this.expectPeek(TokenType.IDENT)) {
      return { success: false, error: "Invalid CREATE TABLE syntax" };
    }

    const tableName = this.currentToken.literal;

    if (!this.expectPeek(TokenType.LPAREN)) {
      return { success: false, error: "Invalid CREATE TABLE syntax" };
    }

    // カラム定義をパース
    const columns: ColumnDef[] = [];

    while (!this.peekTokenIs(TokenType.RPAREN) && !this.peekTokenIs(TokenType.EOF)) {
      this.nextToken();
      const colResult = this.parseColumnDef();
      if (!colResult.success) {
        return colResult;
      }
      columns.push(colResult.column);

      // カンマがあれば次のカラムへ
      if (this.peekTokenIs(TokenType.COMMA)) {
        this.nextToken();
      }
    }

    if (!this.expectPeek(TokenType.RPAREN)) {
      return { success: false, error: "Invalid CREATE TABLE syntax" };
    }

    if (columns.length === 0) {
      return { success: false, error: "Invalid CREATE TABLE syntax" };
    }

    return {
      success: true,
      statement: { type: "CREATE_TABLE", tableName, columns },
    };
  }

  private parseColumnDef(): { success: true; column: ColumnDef } | { success: false; error: string } {
    // カラム名
    if (!this.curTokenIs(TokenType.IDENT)) {
      return {
        success: false,
        error: `Invalid column definition: ${this.currentToken.literal}`,
      };
    }
    const colName = this.currentToken.literal;

    // カラム型
    this.nextToken();
    const colType = this.parseColumnType();
    if (!colType) {
      return {
        success: false,
        error: `Invalid column definition: ${colName}`,
      };
    }

    // 制約（オプション）
    const constraints: ColumnConstraint[] = [];
    while (
      this.peekTokenIs(TokenType.PRIMARY) ||
      this.peekTokenIs(TokenType.NOT) ||
      this.peekTokenIs(TokenType.UNIQUE)
    ) {
      this.nextToken();
      if (this.curTokenIs(TokenType.PRIMARY)) {
        if (this.expectPeek(TokenType.KEY)) {
          constraints.push("PRIMARY_KEY");
        }
      } else if (this.curTokenIs(TokenType.NOT)) {
        if (this.expectPeek(TokenType.NULL_KW)) {
          constraints.push("NOT_NULL");
        }
      } else if (this.curTokenIs(TokenType.UNIQUE)) {
        constraints.push("UNIQUE");
      }
    }

    return {
      success: true,
      column: { name: colName, type: colType, constraints },
    };
  }

  private parseColumnType(): ColumnType | null {
    if (this.curTokenIs(TokenType.INTEGER_KW)) return "INTEGER";
    if (this.curTokenIs(TokenType.INT_KW)) return "INTEGER"; // INT → INTEGER に正規化
    if (this.curTokenIs(TokenType.TEXT_KW)) return "TEXT";
    return null;
  }

  // ============================================================
  // INSERT INTO パーサー
  // ============================================================

  private parseInsert(): ParseResult {
    // INSERT INTO <tableName>
    if (!this.expectPeek(TokenType.INTO)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }
    if (!this.expectPeek(TokenType.IDENT)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }

    const tableName = this.currentToken.literal;

    // ( カラムリスト )
    if (!this.expectPeek(TokenType.LPAREN)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }

    const columns = this.parseIdentifierList();
    if (columns === null) {
      return { success: false, error: "Invalid INSERT syntax" };
    }

    if (!this.expectPeek(TokenType.RPAREN)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }

    // VALUES ( 値リスト )
    if (!this.expectPeek(TokenType.VALUES)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }
    if (!this.expectPeek(TokenType.LPAREN)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }

    const valuesResult = this.parseValueList();
    if (!valuesResult.success) {
      return valuesResult;
    }

    if (!this.expectPeek(TokenType.RPAREN)) {
      return { success: false, error: "Invalid INSERT syntax" };
    }

    return {
      success: true,
      statement: { type: "INSERT", tableName, columns, values: valuesResult.values },
    };
  }

  private parseIdentifierList(): string[] | null {
    const identifiers: string[] = [];

    if (!this.expectPeek(TokenType.IDENT)) {
      return null;
    }
    identifiers.push(this.currentToken.literal);

    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken(); // skip comma
      if (!this.expectPeek(TokenType.IDENT)) {
        return null;
      }
      identifiers.push(this.currentToken.literal);
    }

    return identifiers;
  }

  private parseValueList(): { success: true; values: (string | number)[] } | { success: false; error: string } {
    const values: (string | number)[] = [];

    this.nextToken();
    const first = this.parseValue();
    if (first === null) {
      return { success: false, error: `Invalid value: ${this.currentToken.literal}` };
    }
    values.push(first);

    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken(); // skip comma
      this.nextToken();
      const val = this.parseValue();
      if (val === null) {
        return { success: false, error: `Invalid value: ${this.currentToken.literal}` };
      }
      values.push(val);
    }

    return { success: true, values };
  }

  // ============================================================
  // SELECT パーサー
  // ============================================================

  private parseSelect(): ParseResult {
    // SELECT <columns> FROM <tableName>
    this.nextToken();

    // カラムリスト
    const columns: string[] = [];
    if (this.curTokenIs(TokenType.ASTERISK)) {
      columns.push("*");
    } else if (this.curTokenIs(TokenType.IDENT)) {
      columns.push(this.currentToken.literal);
      while (this.peekTokenIs(TokenType.COMMA)) {
        this.nextToken(); // skip comma
        this.nextToken();
        columns.push(this.currentToken.literal);
      }
    } else {
      return { success: false, error: "Invalid SELECT syntax" };
    }

    // FROM
    if (!this.expectPeek(TokenType.FROM)) {
      return { success: false, error: "Invalid SELECT syntax" };
    }
    if (!this.expectPeek(TokenType.IDENT)) {
      return { success: false, error: "Invalid SELECT syntax" };
    }

    const tableName = this.currentToken.literal;
    const where: Record<string, WhereCondition> = {};

    // WHERE (オプション)
    if (this.peekTokenIs(TokenType.WHERE)) {
      this.nextToken(); // skip WHERE
      const whereResult = this.parseWhereClause();
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

  private parseWhereClause():
    | { success: true; conditions: Record<string, WhereCondition> }
    | { success: false; error: string } {
    const conditions: Record<string, WhereCondition> = {};

    // 最初の条件
    const first = this.parseWhereCondition();
    if (!first.success) return first;
    conditions[first.column] = first.condition;

    // AND で繋がる追加条件
    while (this.peekTokenIs(TokenType.AND)) {
      this.nextToken(); // skip AND
      const cond = this.parseWhereCondition();
      if (!cond.success) return cond;
      conditions[cond.column] = cond.condition;
    }

    return { success: true, conditions };
  }

  private parseWhereCondition():
    | { success: true; column: string; condition: WhereCondition }
    | { success: false; error: string } {
    // カラム名
    if (!this.expectPeek(TokenType.IDENT)) {
      return { success: false, error: "Invalid WHERE condition" };
    }
    const column = this.currentToken.literal;

    // 演算子
    this.nextToken();
    const operator = this.parseOperator();
    if (!operator) {
      return { success: false, error: `Invalid WHERE condition: ${column}` };
    }

    // 値
    this.nextToken();
    const value = this.parseValue();
    if (value === null) {
      return { success: false, error: `Invalid value in WHERE: ${this.currentToken.literal}` };
    }

    return { success: true, column, condition: { operator, value } };
  }

  private parseOperator(): WhereCondition["operator"] | null {
    switch (this.currentToken.type) {
      case TokenType.EQ:
        return "=";
      case TokenType.NEQ:
        return "!=";
      case TokenType.GT:
        return ">";
      case TokenType.LT:
        return "<";
      case TokenType.GTE:
        return ">=";
      case TokenType.LTE:
        return "<=";
      default:
        return null;
    }
  }

  // ============================================================
  // 値パーサー
  // ============================================================

  private parseValue(): string | number | null {
    if (this.curTokenIs(TokenType.STRING)) {
      return this.currentToken.literal;
    }
    if (this.curTokenIs(TokenType.NUMBER)) {
      const num = Number(this.currentToken.literal);
      if (!Number.isNaN(num) && Number.isInteger(num)) {
        return num;
      }
      return null;
    }
    return null;
  }
}
