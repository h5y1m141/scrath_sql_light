# Issue #1: SQL パーサーリファクタリング計画

## 背景・動機

現状の `src/sql/parser.ts` は正規表現ベースで SQL文を一括マッチしている。
「[Go言語でつくるインタプリタ](https://www.oreilly.co.jp/books/9784873118222/)」を TypeScript で実装し直したサンプルコード（`reference/interpreter_sample`）では **Token定義 → Lexer(字句解析) → Parser(構文解析)** という段階的アーキテクチャを採用しており、この設計をベースに SQL パーサーをリファクタリングする。

### 現状の問題
- 正規表現が複雑になりがちで新しい SQL 構文の追加が難しい
- エラーメッセージが「Invalid XXX syntax」と大まかで、どのトークン位置が問題かわからない
- Lexer/Parser の責務が分離されておらず、テスタビリティが低い

### ゴール
- サンプルコードの **Lexer → Token列 → Parser** パターンを導入
- 外部インターフェース（`parse()` 関数、型定義のエクスポート）は変更せず、既存テスト全パス
- `database.ts`, `main.ts` など下流コードへの影響ゼロ

---

## 現状のアーキテクチャ

```
SQL文字列 → parse() → 正規表現マッチ → Statement型
```

- `src/sql/parser.ts` (288行) に全てが集約
- `removeComments()`, `parseCreateTable()`, `parseInsert()`, `parseSelect()` 各関数が個別の正規表現で処理
- 外部に公開: `parse()` 関数、型定義 (`Statement`, `CreateTableStatement`, `InsertStatement`, `SelectStatement`, `ColumnDef`, `WhereCondition`, `ParseResult` 等)

### 依存関係（影響を受けるファイル）
- `src/sql/parser.test.ts` — `parse()` と型をインポート
- `src/db/database.ts` — `Statement`, `CreateTableStatement`, `InsertStatement`, `SelectStatement`, `ColumnDef` をインポート
- `src/db/database.test.ts` — `parse()` をインポート
- `src/main.ts` — `parse()` をインポート

---

## リファレンス: サンプルコードの設計パターン

「Go言語でつくるインタプリタ」の TypeScript 実装（`reference/interpreter_sample/src/`）より抽出:

### token.ts のパターン
- カテゴリ別 `const` オブジェクト（`SpecialTokens`, `Operators`, `Delimiters`, `Keywords`）
- スプレッドで統合した `TokenType` オブジェクト
- `Token` クラス: `type` + `literal`
- `Token.lookupIdent()`: 識別子がキーワードか判定

### lexer.ts のパターン
- **dual-pointer**: `position`（現在位置）と `readPosition`（先読み位置）
- `currentCharacter`: 現在の文字
- `nextToken()`: switch文でトークン切り出し
- `peekChar()`: 先読み（`==`, `!=` 等の2文字演算子対応）
- `readIdentifier()` / `readNumber()`: 連続文字の読み取り
- `skipWhitespace()`: 空白スキップ

### parser.ts のパターン
- `currentToken` / `peekToken` の dual-token window
- `nextToken()`, `expectPeek()`, `curTokenIs()`, `peekTokenIs()` ヘルパー
- `errors` 配列にエラーを蓄積

---

## リファクタリング計画

### ファイル構成（変更後）

```
src/sql/
├── token.ts          ← 新規: SQL トークン型定義
├── lexer.ts          ← 新規: SQL 字句解析器
├── lexer.test.ts     ← 新規: Lexer 単体テスト
├── parser.ts         ← リファクタ: トークンベースに書き換え
└── parser.test.ts    ← 変更なし（既存テスト）
```

### Step 1: `src/sql/token.ts` を新規作成

SQL 用トークン型をサンプルコードの token.ts パターンに従って定義する。

```typescript
// カテゴリ別定義
export const SpecialTokens = {
  ILLEGAL: 'ILLEGAL',
  EOF: 'EOF',
} as const

export const SqlKeywords = {
  CREATE: 'CREATE',
  TABLE: 'TABLE',
  INSERT: 'INSERT',
  INTO: 'INTO',
  VALUES: 'VALUES',
  SELECT: 'SELECT',
  FROM: 'FROM',
  WHERE: 'WHERE',
  AND: 'AND',
  PRIMARY: 'PRIMARY',
  KEY: 'KEY',
  NOT: 'NOT',
  NULL_KW: 'NULL',    // null リテラルと区別
  UNIQUE: 'UNIQUE',
  INT_KW: 'INT',      // INT型キーワード
  INTEGER_KW: 'INTEGER',
  TEXT_KW: 'TEXT',
} as const

export const Operators = {
  EQ: '=',
  NEQ: '!=',
  GT: '>',
  LT: '<',
  GTE: '>=',
  LTE: '<=',
} as const

export const Delimiters = {
  LPAREN: '(',
  RPAREN: ')',
  COMMA: ',',
  SEMICOLON: ';',
  ASTERISK: '*',
} as const

export const Literals = {
  IDENT: 'IDENT',
  NUMBER: 'NUMBER',
  STRING: 'STRING',
} as const

export const TokenType = {
  ...SpecialTokens,
  ...SqlKeywords,
  ...Operators,
  ...Delimiters,
  ...Literals,
} as const

export type TokenType = (typeof TokenType)[keyof typeof TokenType]

export class Token {
  constructor(
    public type: TokenType,
    public literal: string,
  ) {}

  // SQL キーワードマップ（大文字小文字無視で判定）
  static keywords: Record<string, TokenType> = {
    'CREATE': TokenType.CREATE,
    'TABLE': TokenType.TABLE,
    'INSERT': TokenType.INSERT,
    'INTO': TokenType.INTO,
    'VALUES': TokenType.VALUES,
    'SELECT': TokenType.SELECT,
    'FROM': TokenType.FROM,
    'WHERE': TokenType.WHERE,
    'AND': TokenType.AND,
    'PRIMARY': TokenType.PRIMARY,
    'KEY': TokenType.KEY,
    'NOT': TokenType.NOT,
    'NULL': TokenType.NULL_KW,
    'UNIQUE': TokenType.UNIQUE,
    'INT': TokenType.INT_KW,
    'INTEGER': TokenType.INTEGER_KW,
    'TEXT': TokenType.TEXT_KW,
  }

  static lookupIdent(ident: string): TokenType {
    return Token.keywords[ident.toUpperCase()] ?? TokenType.IDENT
  }
}
```

### Step 2: `src/sql/lexer.ts` を新規作成

サンプルコードの lexer.ts パターンを踏襲し、SQL 固有の拡張を加える。

```typescript
export class Lexer {
  private input: string
  private position: number
  private readPosition: number
  private currentCharacter: string

  constructor(input: string) { /* dual-pointer 初期化 */ }

  nextToken(): Token {
    this.skipWhitespace()
    this.skipLineComment()  // SQL固有: '--' コメント
    this.skipWhitespace()   // コメント後の空白もスキップ

    switch (this.currentCharacter) {
      case '(': ...
      case ')': ...
      case ',': ...
      case ';': ...
      case '*': ...
      case '=': ...
      case '!': // peekChar で '!=' 判定
      case '>': // peekChar で '>=' 判定
      case '<': // peekChar で '<=' 判定
      case "'": return this.readString("'")   // SQL固有
      case '"': return this.readString('"')   // SQL固有
      case '\0': return EOF
      default:
        if (isLetter) → readIdentifier() → lookupIdent()
        if (isDigit) → readNumber()
        else → ILLEGAL
    }
  }

  // サンプルコードと同じヘルパー群
  private readChar(): void
  private peekChar(): string
  private skipWhitespace(): void
  private readIdentifier(): string
  private readNumber(): string

  // SQL 固有の拡張
  private skipLineComment(): void   // '--' から行末まで
  private readString(quote: string): Token  // クォート文字列
}
```

### Step 3: `src/sql/lexer.test.ts` を新規作成

各 SQL 文をトークン列に変換して検証するテスト。

テストケース例:
- `SELECT * FROM users` → `[SELECT, ASTERISK, FROM, IDENT("users"), EOF]`
- `CREATE TABLE users (id INTEGER PRIMARY KEY)` → 各トークンの検証
- `INSERT INTO users (id) VALUES (1)` → 各トークンの検証
- `-- comment\nSELECT *` → コメントスキップの検証
- 文字列リテラル `'Alice'` → `STRING("Alice")`
- 比較演算子 `>=`, `<=`, `!=` → 正しいトークン型

### Step 4: `src/sql/parser.ts` をリファクタ

**型定義・エクスポートは一切変更しない。** 内部実装のみ書き換え。

```typescript
// --- 型定義セクション: 変更なし ---
export type ColumnType = ...
export type Statement = ...
export type ParseResult = ...

// --- パーサークラス（内部用） ---
class SqlParser {
  private lexer: Lexer
  private currentToken!: Token
  private peekToken!: Token
  private errors: string[] = []

  constructor(input: string) {
    this.lexer = new Lexer(input)
    this.nextToken()
    this.nextToken()
  }

  // サンプルコードと同様のヘルパー群
  private nextToken(): void
  private expectPeek(type: TokenType): boolean
  private curTokenIs(type: TokenType): boolean
  private peekTokenIs(type: TokenType): boolean

  // SQL 文の解析
  parse(): ParseResult {
    if (this.curTokenIs(TokenType.EOF))
      return { success: false, error: "Empty SQL statement" }

    if (this.curTokenIs(TokenType.CREATE))
      return this.parseCreateTable()
    if (this.curTokenIs(TokenType.INSERT))
      return this.parseInsert()
    if (this.curTokenIs(TokenType.SELECT))
      return this.parseSelect()

    return { success: false, error: "Unsupported SQL statement" }
  }

  private parseCreateTable(): ParseResult {
    // expectPeek(TABLE) → expectPeek(IDENT) でテーブル名取得
    // expectPeek(LPAREN) → カラム定義ループ
    // 各カラム: IDENT(名前) + キーワード(型) + オプション制約
    // RPAREN で終了
  }

  private parseInsert(): ParseResult {
    // expectPeek(INTO) → expectPeek(IDENT) でテーブル名
    // LPAREN → カラム名リスト → RPAREN
    // expectPeek(VALUES)
    // LPAREN → 値リスト → RPAREN
  }

  private parseSelect(): ParseResult {
    // カラムリスト（ASTERISK or IDENT,IDENT,...）
    // expectPeek(FROM) → expectPeek(IDENT) でテーブル名
    // オプショナル: WHERE → parseWhereClause()
  }

  private parseWhereClause(): Record<string, WhereCondition> | ParseResult {
    // IDENT → 演算子トークン → 値 の繰り返し
    // AND で区切り
  }

  private parseValue(): string | number | null {
    // NUMBER → 数値
    // STRING → 文字列
  }
}

// --- エントリーポイント: シグネチャ変更なし ---
export function parse(sql: string): ParseResult {
  const parser = new SqlParser(sql)
  return parser.parse()
}
```

### Step 5: テスト実行

```bash
bun test src/sql/
```

既存の `parser.test.ts`（30+ テストケース）＋ 新規の `lexer.test.ts` が全てパスすれば完了。

---

## 変更しないもの

| ファイル | 理由 |
|---|---|
| `src/sql/parser.test.ts` | 既存テストを回帰テストとしてそのまま使う |
| `src/db/database.ts` | `parse()` と型定義の外部インターフェースが不変 |
| `src/db/database.test.ts` | 同上 |
| `src/main.ts` | 同上 |

## 検証方法

```bash
# Lexer テスト + Parser テスト
bun test src/sql/

# 念のため全テスト
bun test
```
