// ============================================================
// 特殊トークン
// ============================================================

export const SpecialTokens = {
  ILLEGAL: "ILLEGAL",
  EOF: "EOF",
} as const;

// ============================================================
// SQL キーワード
// ============================================================

export const SqlKeywords = {
  CREATE: "CREATE",
  TABLE: "TABLE",
  INSERT: "INSERT",
  INTO: "INTO",
  VALUES: "VALUES",
  SELECT: "SELECT",
  FROM: "FROM",
  WHERE: "WHERE",
  AND: "AND",
  PRIMARY: "PRIMARY",
  KEY: "KEY",
  NOT: "NOT",
  NULL_KW: "NULL",
  UNIQUE: "UNIQUE",
  INT_KW: "INT",
  INTEGER_KW: "INTEGER",
  TEXT_KW: "TEXT",
} as const;

// ============================================================
// 演算子
// ============================================================

export const Operators = {
  EQ: "=",
  NEQ: "!=",
  GT: ">",
  LT: "<",
  GTE: ">=",
  LTE: "<=",
} as const;

// ============================================================
// デリミタ
// ============================================================

export const Delimiters = {
  LPAREN: "(",
  RPAREN: ")",
  COMMA: ",",
  SEMICOLON: ";",
  ASTERISK: "*",
} as const;

// ============================================================
// リテラル
// ============================================================

export const Literals = {
  IDENT: "IDENT",
  NUMBER: "NUMBER",
  STRING: "STRING",
} as const;

// ============================================================
// TokenType 統合
// ============================================================

export const TokenType = {
  ...SpecialTokens,
  ...SqlKeywords,
  ...Operators,
  ...Delimiters,
  ...Literals,
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

// ============================================================
// Token クラス
// ============================================================

export class Token {
  constructor(
    public type: TokenType,
    public literal: string,
  ) {}

  static keywords: Record<string, TokenType> = {
    CREATE: TokenType.CREATE,
    TABLE: TokenType.TABLE,
    INSERT: TokenType.INSERT,
    INTO: TokenType.INTO,
    VALUES: TokenType.VALUES,
    SELECT: TokenType.SELECT,
    FROM: TokenType.FROM,
    WHERE: TokenType.WHERE,
    AND: TokenType.AND,
    PRIMARY: TokenType.PRIMARY,
    KEY: TokenType.KEY,
    NOT: TokenType.NOT,
    NULL: TokenType.NULL_KW,
    UNIQUE: TokenType.UNIQUE,
    INT: TokenType.INT_KW,
    INTEGER: TokenType.INTEGER_KW,
    TEXT: TokenType.TEXT_KW,
  };

  static lookupIdent(ident: string): TokenType {
    return Token.keywords[ident.toUpperCase()] ?? TokenType.IDENT;
  }
}
