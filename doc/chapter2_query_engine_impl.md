# 2章: クエリーエンジンの実装詳細

> **この章で理解できること:** Lexer・Parser の各クラスがどのようなアルゴリズムで SQL 文字列をトークン列に分解し、さらに Statement 型に組み立てるか、コードレベルで理解する。

> **概念は → [1章: クエリーエンジンの概念](./chapter1_query_engine_concepts.md) を参照してください**

---

## 2-1 トークン定義 (token.ts)

### 2-1-1 カテゴリ設計

**この節で理解できること:** トークンの種類がどのように分類・定義され、一つの `TokenType` に統合されるか。

本プロジェクトでは、トークンの種類を **5つのカテゴリ** に分けて `as const` オブジェクトとして定義している。

| カテゴリ | 定数名 | 役割 | 例 |
|---|---|---|---|
| 特殊トークン | `SpecialTokens` | 入力の終端や不正文字 | `ILLEGAL`, `EOF` |
| SQLキーワード | `SqlKeywords` | SQL予約語 | `CREATE`, `SELECT`, `WHERE` |
| 演算子 | `Operators` | 比較演算子 | `=`, `!=`, `>=` |
| デリミタ | `Delimiters` | 区切り文字 | `(`, `)`, `,`, `;`, `*` |
| リテラル | `Literals` | 値の種類を表すメタタイプ | `IDENT`, `NUMBER`, `STRING` |

各カテゴリの定義例を見てみよう。

```typescript
// src/sql/token.ts:5-8
export const SpecialTokens = {
  ILLEGAL: "ILLEGAL",
  EOF: "EOF",
} as const;
```

```typescript
// src/sql/token.ts:14-32
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
```

`NULL_KW`、`INT_KW`、`INTEGER_KW`、`TEXT_KW` のように `_KW` サフィックスが付いているのは、TypeScript の予約語や型名との衝突を避けるためである。例えば `NULL` をそのままキーとすると `as const` で推論される型リテラルとしては問題ないが、value 側の文字列 `"NULL"` と区別するために命名規則を統一している。

```typescript
// src/sql/token.ts:38-45
export const Operators = {
  EQ: "=",
  NEQ: "!=",
  GT: ">",
  LT: "<",
  GTE: ">=",
  LTE: "<=",
} as const;
```

```typescript
// src/sql/token.ts:51-57
export const Delimiters = {
  LPAREN: "(",
  RPAREN: ")",
  COMMA: ",",
  SEMICOLON: ";",
  ASTERISK: "*",
} as const;
```

```typescript
// src/sql/token.ts:63-67
export const Literals = {
  IDENT: "IDENT",
  NUMBER: "NUMBER",
  STRING: "STRING",
} as const;
```

#### スプレッドによる TokenType 統合と TypeScript の型推論

5つのカテゴリは、スプレッド演算子で1つの `TokenType` オブジェクトに統合される。

```typescript
// src/sql/token.ts:73-81
export const TokenType = {
  ...SpecialTokens,
  ...SqlKeywords,
  ...Operators,
  ...Delimiters,
  ...Literals,
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];
```

ここでは **value（定数オブジェクト）と type（型エイリアス）に同じ名前 `TokenType` を付けている**。TypeScript では値と型は別の名前空間に存在するため、これが合法である。

- `TokenType.SELECT` と書くと **値** として `"SELECT"` が返る（ランタイムで使う）
- `type: TokenType` と書くと **型** として `"ILLEGAL" | "EOF" | "CREATE" | ... | "STRING"` というユニオン型になる（コンパイル時の型チェックで使う）

この設計により、`TokenType.SELECT` のような列挙的なアクセスと、関数引数の型注釈を **1つの名前で統一** できる。

---

### 2-1-2 Token クラスとキーワード判定

**この節で理解できること:** Token クラスの構造と、識別子がキーワードかどうかを判定する仕組み。

#### Token クラスの構造

```typescript
// src/sql/token.ts:87-91
export class Token {
  constructor(
    public type: TokenType,
    public literal: string,
  ) {}
```

Token は 2つのフィールドを持つ。

| フィールド | 型 | 役割 |
|---|---|---|
| `type` | `TokenType` | トークンの種類（例: `"SELECT"`, `"IDENT"`, `"NUMBER"`） |
| `literal` | `string` | ソースコード上の元の文字列（例: `"users"`, `"42"`, `"hello"`） |

例えば SQL `SELECT * FROM users` のトークン列は以下のようになる。

| type | literal |
|---|---|
| `"SELECT"` | `"SELECT"` |
| `"*"` | `"*"` |
| `"FROM"` | `"FROM"` |
| `"IDENT"` | `"users"` |
| `"EOF"` | `""` |

キーワード（`SELECT`, `FROM`）の場合は `type` と `literal` が同じ値になるが、識別子（`users`）の場合は `type` が `"IDENT"` で `literal` が実際の名前になる。

#### keywords 静的マップ

```typescript
// src/sql/token.ts:93-111
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
```

`keywords` は **大文字のキーワード文字列** をキーとして、対応する `TokenType` をマッピングする静的フィールドである。`SqlKeywords` のキー名（例: `NULL_KW`）ではなく、SQL で実際に書かれる文字列（例: `"NULL"`）をキーにしている点に注意。

#### lookupIdent() — 大文字小文字を無視したキーワード照合

```typescript
// src/sql/token.ts:113-115
  static lookupIdent(ident: string): TokenType {
    return Token.keywords[ident.toUpperCase()] ?? TokenType.IDENT;
  }
```

Lexer が識別子を読み取った後、この `lookupIdent()` を呼ぶことで **キーワードか一般識別子かを判別** する。

1. 引数 `ident` を `toUpperCase()` で大文字に変換
2. `keywords` マップを検索
3. ヒットすればそのキーワードの `TokenType` を返す
4. ヒットしなければ `TokenType.IDENT`（一般識別子）を返す

これにより `select`、`SELECT`、`Select` のいずれも同じ `TokenType.SELECT` として認識される。

---

## 2-2 字句解析 (lexer.ts)

### 2-2-1 基本構造 (dual-pointer)

**この節で理解できること:** Lexer が入力文字列を1文字ずつ走査するためのポインタ管理の仕組み。

```typescript
// src/sql/lexer.ts:7-20
export class Lexer {
  private input: string;
  private position: number;
  private readPosition: number;
  private currentCharacter: string;

  constructor(input: string) {
    this.input = input;
    this.position = 0;
    this.readPosition = 0;
    this.currentCharacter = "";

    this.readChar();
  }
```

Lexer は **3つのフィールド** で入力文字列上の位置を管理する。

| フィールド | 役割 |
|---|---|
| `position` | 現在処理中の文字のインデックス |
| `readPosition` | 次に読む文字のインデックス（常に `position + 1`） |
| `currentCharacter` | 現在処理中の文字そのもの |

`position` と `readPosition` の2つのポインタを使うのは、**先読み（peek）** を実現するためである。`readPosition` は常に1つ先を指しているため、`peekChar()` で次の文字を確認できる。

```
入力: "SELECT * FROM users"
       ^      ^
       |      |
       position=0  readPosition=1
       currentCharacter="S"
```

#### readChar() と peekChar()

```typescript
// src/sql/lexer.ts:101-108
  private readChar(): void {
    this.currentCharacter =
      this.readPosition >= this.input.length
        ? "\0"
        : this.input[this.readPosition];
    this.position = this.readPosition;
    this.readPosition += 1;
  }
```

`readChar()` は1文字進める操作である。入力の末尾を超えると `"\0"`（ヌル文字）を設定する。これにより、呼び出し側は常に `currentCharacter` を安全に参照できる。

```typescript
// src/sql/lexer.ts:110-115
  private peekChar(): string {
    if (this.readPosition >= this.input.length) {
      return "\0";
    }
    return this.input[this.readPosition];
  }
```

`peekChar()` は **ポインタを進めずに** 次の文字を返す。2文字演算子（`!=`, `>=`, `<=`）の判定で使われる。

---

### 2-2-2 nextToken() メインループ

**この節で理解できること:** Lexer が1つのトークンを切り出す判断フローの全体像。

`nextToken()` は Lexer の中核メソッドで、呼び出すたびに次のトークンを1つ返す。

```typescript
// src/sql/lexer.ts:22-95
  nextToken(): Token {
    this.skipWhitespaceAndComments();

    let token: Token;

    switch (this.currentCharacter) {
      case "(":
        token = new Token(TokenType.LPAREN, this.currentCharacter);
        break;
      case ")":
        token = new Token(TokenType.RPAREN, this.currentCharacter);
        break;
      case ",":
        token = new Token(TokenType.COMMA, this.currentCharacter);
        break;
      case ";":
        token = new Token(TokenType.SEMICOLON, this.currentCharacter);
        break;
      case "*":
        token = new Token(TokenType.ASTERISK, this.currentCharacter);
        break;
      case "=":
        token = new Token(TokenType.EQ, this.currentCharacter);
        break;
```

処理の流れは以下の通りである。

1. **空白・コメントをスキップ** — `skipWhitespaceAndComments()`
2. **switch 文** で現在の文字を判定
   - `(`, `)`, `,`, `;`, `*`, `=` → 即座に1文字トークンを生成
   - `!`, `>`, `<` → 先読みで2文字演算子かどうかを判定
   - `'`, `"` → 文字列リテラルの読み取りへ
   - `\0` → EOF トークンを返す
3. **default** で英字か数字かを判定
   - 英字 → `readIdentifier()` で識別子を読み取り、`lookupIdent()` でキーワード判定
   - 数字 → `readNumber()` で数値リテラルを読み取り
   - それ以外 → `ILLEGAL` トークン

#### 2文字演算子の先読み

`!`, `>`, `<` は1文字だけでは演算子の種類が確定しない。例えば `>` は `>` (GT) か `>=` (GTE) の可能性がある。

```typescript
// src/sql/lexer.ts:55-72
      case ">":
        if (this.peekChar() === "=") {
          const ch = this.currentCharacter;
          this.readChar();
          token = new Token(TokenType.GTE, ch + this.currentCharacter);
        } else {
          token = new Token(TokenType.GT, this.currentCharacter);
        }
        break;
      case "<":
        if (this.peekChar() === "=") {
          const ch = this.currentCharacter;
          this.readChar();
          token = new Token(TokenType.LTE, ch + this.currentCharacter);
        } else {
          token = new Token(TokenType.LT, this.currentCharacter);
        }
        break;
```

`peekChar()` で次の文字が `=` かどうかを確認し、`=` であれば `readChar()` で1文字進めてから2文字分を結合した literal を生成する。`!` の場合は次の文字が `=` でなければ `ILLEGAL` になる点が `>` / `<` と異なる。

```typescript
// src/sql/lexer.ts:46-54
      case "!":
        if (this.peekChar() === "=") {
          const ch = this.currentCharacter;
          this.readChar();
          token = new Token(TokenType.NEQ, ch + this.currentCharacter);
        } else {
          token = new Token(TokenType.ILLEGAL, this.currentCharacter);
        }
        break;
```

#### 識別子・数値・文字列への分岐

```typescript
// src/sql/lexer.ts:79-90
      default:
        if (this.isLetter(this.currentCharacter)) {
          const literal = this.readIdentifier();
          const type = Token.lookupIdent(literal);
          return new Token(type, literal);
        }
        if (this.isDigit(this.currentCharacter)) {
          const literal = this.readNumber();
          return new Token(TokenType.NUMBER, literal);
        }
        token = new Token(TokenType.ILLEGAL, this.currentCharacter);
        break;
```

`default` ブロックでは `isLetter()` / `isDigit()` で文字の種類を判定する。識別子と数値リテラルの場合は `readIdentifier()` / `readNumber()` が内部で `readChar()` を進めるため、`return` で直接トークンを返す（末尾の `this.readChar()` をスキップする）。文字列リテラル（`'` / `"`）も同様に `return` で直接返す。

```typescript
// src/sql/lexer.ts:73-75
      case "'":
      case '"':
        return this.readString(this.currentCharacter);
```

---

### 2-2-3 空白・コメント処理

**この節で理解できること:** SQL の空白文字とコメントを透過的にスキップする仕組み。

#### skipWhitespace()

```typescript
// src/sql/lexer.ts:135-144
  private skipWhitespace(): void {
    while (
      this.currentCharacter === " " ||
      this.currentCharacter === "\t" ||
      this.currentCharacter === "\n" ||
      this.currentCharacter === "\r"
    ) {
      this.readChar();
    }
  }
```

スペース、タブ、改行（LF / CR）を読み飛ばす。

#### skipLineComment() — SQL の「--」コメント

```typescript
// src/sql/lexer.ts:146-158
  private skipLineComment(): void {
    // '--' から行末までスキップ
    while (
      this.currentCharacter !== "\n" &&
      this.currentCharacter !== "\0"
    ) {
      this.readChar();
    }
    // 改行自体もスキップ
    if (this.currentCharacter === "\n") {
      this.readChar();
    }
  }
```

SQL の行コメント `--` 以降を行末（`\n`）またはファイル末尾（`\0`）までスキップする。改行文字自体もスキップする。

#### skipWhitespaceAndComments() — 交互スキップ

```typescript
// src/sql/lexer.ts:121-133
  private skipWhitespaceAndComments(): void {
    while (true) {
      this.skipWhitespace();
      if (
        this.currentCharacter === "-" &&
        this.peekChar() === "-"
      ) {
        this.skipLineComment();
      } else {
        break;
      }
    }
  }
```

空白とコメントが交互に出現するケース（例: 空白の後にコメント、コメント後にまた空白）を正しく処理するため、無限ループ内で交互にスキップを行い、どちらでもない文字に到達したら `break` する。

以下のような SQL を考えると、この交互スキップが必要な理由がわかる。

```sql
SELECT *   -- 全カラム取得
  FROM users
```

`*` の後に空白 → コメント → 改行 → 空白 → `FROM` という並びになるが、`skipWhitespaceAndComments()` はこれをすべて透過的にスキップし、次の有効トークン `FROM` に到達する。

---

### 2-2-4 リテラル読み取り

**この節で理解できること:** 識別子・数値・文字列を複数文字にわたって読み取る方法と文字判定関数の仕様。

#### readIdentifier() — 英字/数字/アンダースコア

```typescript
// src/sql/lexer.ts:164-170
  private readIdentifier(): string {
    const start = this.position;
    while (this.isLetter(this.currentCharacter) || this.isDigit(this.currentCharacter)) {
      this.readChar();
    }
    return this.input.substring(start, this.position);
  }
```

開始位置 `start` を記録し、英字・数字・アンダースコアが続く限り `readChar()` で進める。最後に `substring(start, position)` で切り出す。識別子の先頭文字は `isLetter()` で判定済み（`nextToken()` の `default` ブロック参照）なので、ここでは2文字目以降に数字も許容される。

例えば `user_name123` という入力の場合:
1. `start = position` (先頭の `u` の位置)
2. `u`, `s`, `e`, `r`, `_`, `n`, `a`, `m`, `e`, `1`, `2`, `3` まで進む
3. 次の文字が英字でも数字でもなければループを抜ける
4. `"user_name123"` を返す

#### readNumber()

```typescript
// src/sql/lexer.ts:172-178
  private readNumber(): string {
    const start = this.position;
    while (this.isDigit(this.currentCharacter)) {
      this.readChar();
    }
    return this.input.substring(start, this.position);
  }
```

`readIdentifier()` と同じパターンだが、数字のみを受け付ける。現時点では整数のみ対応しており、小数点（`.`）は扱わない。

#### readString() — クォート文字列

```typescript
// src/sql/lexer.ts:180-196
  private readString(quote: string): Token {
    // クォート文字をスキップ
    this.readChar();
    const start = this.position;
    while (
      this.currentCharacter !== quote &&
      this.currentCharacter !== "\0"
    ) {
      this.readChar();
    }
    const literal = this.input.substring(start, this.position);
    // 閉じクォートをスキップ
    if (this.currentCharacter === quote) {
      this.readChar();
    }
    return new Token(TokenType.STRING, literal);
  }
```

文字列リテラルの読み取りは以下の手順で行われる。

1. 開きクォート（`'` または `"`）をスキップ
2. 閉じクォートまたは `\0` が現れるまで `readChar()` で進める
3. `substring()` でクォートの中身だけを切り出す（クォート自体は含まない）
4. 閉じクォートをスキップ
5. `TokenType.STRING` のトークンを返す

例えば `'hello world'` の場合、`literal` は `"hello world"` になる。引数 `quote` でシングルクォートとダブルクォートの両方に対応している。

#### isLetter() / isDigit()

```typescript
// src/sql/lexer.ts:202-208
  private isLetter(ch: string): boolean {
    return (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "_"
    );
  }
```

```typescript
// src/sql/lexer.ts:210-212
  private isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9";
  }
```

`isLetter()` は英小文字・英大文字・アンダースコアを「文字」とみなす。アンダースコアを含めることで `user_name` のような識別子を正しく処理できる。`isDigit()` は ASCII の数字のみを対象とする。

---

### 字句解析のデータフロー例

SQL `INSERT INTO users (id, name) VALUES (1, 'Alice');` が Lexer を通過する様子を追ってみよう。

```
入力: INSERT INTO users (id, name) VALUES (1, 'Alice');

nextToken() 呼び出し  →  生成されるトークン
────────────────────────────────────────────────
 1回目: "INSERT"        →  Token { type: "INSERT",  literal: "INSERT" }
 2回目: "INTO"          →  Token { type: "INTO",    literal: "INTO" }
 3回目: "users"         →  Token { type: "IDENT",   literal: "users" }
 4回目: "("             →  Token { type: "(",       literal: "(" }
 5回目: "id"            →  Token { type: "IDENT",   literal: "id" }
 6回目: ","             →  Token { type: ",",       literal: "," }
 7回目: "name"          →  Token { type: "IDENT",   literal: "name" }
 8回目: ")"             →  Token { type: ")",       literal: ")" }
 9回目: "VALUES"        →  Token { type: "VALUES",  literal: "VALUES" }
10回目: "("             →  Token { type: "(",       literal: "(" }
11回目: "1"             →  Token { type: "NUMBER",  literal: "1" }
12回目: ","             →  Token { type: ",",       literal: "," }
13回目: "Alice"         →  Token { type: "STRING",  literal: "Alice" }
14回目: ")"             →  Token { type: ")",       literal: ")" }
15回目: ";"             →  Token { type: ";",       literal: ";" }
16回目: ""              →  Token { type: "EOF",     literal: "" }
```

ポイント:
- `INSERT`, `INTO`, `VALUES` は `lookupIdent()` によりキーワードとして認識される
- `users`, `id`, `name` はキーワードに該当しないため `IDENT` になる
- `'Alice'` はクォートの中身だけが `literal` に入り、`type` は `STRING` になる

---

## 2-3 構文解析 (parser.ts)

### 2-3-1 型定義

**この節で理解できること:** Parser が生成する構造化データ（Statement）の型がどのように定義されているか。

#### ColumnType, ColumnConstraint, ColumnDef

```typescript
// src/sql/parser.ts:8
export type ColumnType = "INTEGER" | "TEXT";
```

カラムの型は現在 `INTEGER` と `TEXT` の2種類をサポートしている。

```typescript
// src/sql/parser.ts:10
export type ColumnConstraint = "PRIMARY_KEY" | "NOT_NULL" | "UNIQUE";
```

カラムの制約は3種類。SQL の `PRIMARY KEY` がアンダースコア区切りの `"PRIMARY_KEY"` に正規化される。

```typescript
// src/sql/parser.ts:12-16
export type ColumnDef = {
  name: string;
  type: ColumnType;
  constraints: ColumnConstraint[];
};
```

`ColumnDef` は CREATE TABLE 文のカラム定義1つ分を表す。例えば `id INTEGER PRIMARY KEY NOT NULL` は以下のようになる。

```typescript
{ name: "id", type: "INTEGER", constraints: ["PRIMARY_KEY", "NOT_NULL"] }
```

#### WhereCondition

```typescript
// src/sql/parser.ts:18-21
export type WhereCondition = {
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=";
  value: string | number;
};
```

WHERE 句の1つの条件を表す。カラム名は含まず、演算子と値のペアのみを保持する。カラム名は外側の `Record<string, WhereCondition>` のキーとして保持される（後述）。

#### CreateTableStatement / InsertStatement / SelectStatement

```typescript
// src/sql/parser.ts:23-27
export type CreateTableStatement = {
  type: "CREATE_TABLE";
  tableName: string;
  columns: ColumnDef[];
};
```

```typescript
// src/sql/parser.ts:29-34
export type InsertStatement = {
  type: "INSERT";
  tableName: string;
  columns: string[];
  values: (string | number)[];
};
```

```typescript
// src/sql/parser.ts:36-41
export type SelectStatement = {
  type: "SELECT";
  tableName: string;
  columns: string[];
  where: Record<string, WhereCondition>;
};
```

3つの Statement 型はすべて `type` フィールド（判別用タグ）と `tableName` を共通で持つ。それぞれの固有フィールドは以下の通り。

| Statement | 固有フィールド | 説明 |
|---|---|---|
| `CreateTableStatement` | `columns: ColumnDef[]` | カラム定義の配列 |
| `InsertStatement` | `columns: string[]`, `values: (string \| number)[]` | カラム名リストと値リスト |
| `SelectStatement` | `columns: string[]`, `where: Record<string, WhereCondition>` | 取得カラムとWHERE条件 |

`SelectStatement` の `where` はカラム名をキーとする辞書型になっている。例えば `WHERE id = 1 AND name = 'Alice'` は以下のように表現される。

```typescript
{
  id: { operator: "=", value: 1 },
  name: { operator: "=", value: "Alice" }
}
```

#### Statement (ユニオン型)

```typescript
// src/sql/parser.ts:43
export type Statement = CreateTableStatement | InsertStatement | SelectStatement;
```

`Statement` は3つの Statement 型のユニオンである。`type` フィールドで判別できるため、TypeScript のナローイングが効く。

#### ParseResult (Result型パターン)

```typescript
// src/sql/parser.ts:45-47
export type ParseResult =
  | { success: true; statement: Statement }
  | { success: false; error: string };
```

パースの結果を **Result 型パターン** で表現する。`success: true` の場合は `statement` が取得でき、`success: false` の場合は `error` メッセージが取得できる。例外を投げずにエラーを返すことで、呼び出し側がエラーハンドリングを強制される設計になっている。

---

### 2-3-2 SqlParser 基本構造 (dual-token window)

**この節で理解できること:** Parser が Lexer からトークンを受け取り、2つのトークンを「窓」として保持する仕組み。

```typescript
// src/sql/parser.ts:62-72
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
```

SqlParser は **2つのトークン** を常に保持する。

| フィールド | 役割 |
|---|---|
| `currentToken` | 現在処理中のトークン |
| `peekToken` | 次のトークン（先読み用） |

コンストラクタで `nextToken()` を2回呼ぶことで、`currentToken` と `peekToken` の両方を初期化している。初回の `nextToken()` では `currentToken = undefined`（`!` 修飾子で非 null アサーション）、`peekToken = 最初のトークン` となり、2回目で `currentToken = 最初のトークン`、`peekToken = 2番目のトークン` となる。

この「2トークンの窓」は Lexer の「2ポインタ」と似た発想で、次のトークンを見て分岐を決定するために使われる。

#### nextToken(), curTokenIs(), peekTokenIs(), expectPeek()

```typescript
// src/sql/parser.ts:78-81
  private nextToken(): void {
    this.currentToken = this.peekToken;
    this.peekToken = this.lexer.nextToken();
  }
```

`nextToken()` は窓を1つ進める。`peekToken` を `currentToken` にシフトし、Lexer から新しいトークンを `peekToken` に読み込む。

```typescript
// src/sql/parser.ts:83-85
  private curTokenIs(type: TokenType): boolean {
    return this.currentToken.type === type;
  }
```

```typescript
// src/sql/parser.ts:87-89
  private peekTokenIs(type: TokenType): boolean {
    return this.peekToken.type === type;
  }
```

`curTokenIs()` と `peekTokenIs()` はそれぞれ現在のトークンと次のトークンの型を判定するヘルパーである。

```typescript
// src/sql/parser.ts:91-97
  private expectPeek(type: TokenType): boolean {
    if (this.peekTokenIs(type)) {
      this.nextToken();
      return true;
    }
    return false;
  }
```

`expectPeek()` は **次のトークンが期待する型であれば進める、そうでなければ進めない** という条件付き前進である。パース中に「次は TABLE が来るはず」「次は IDENT が来るはず」という期待を表現するために多用される。戻り値が `false` の場合はパースエラーとして処理される。

---

### 2-3-3 parse() ディスパッチ

**この節で理解できること:** SQL 文の種類を先頭トークンで判別し、対応するパーサーに振り分ける仕組み。

```typescript
// src/sql/parser.ts:103-119
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
```

`parse()` のロジックはシンプルである。

1. `EOF` → 空の SQL としてエラーを返す
2. `CREATE` → `parseCreateTable()` へ
3. `INSERT` → `parseInsert()` へ
4. `SELECT` → `parseSelect()` へ
5. それ以外 → 未対応文としてエラーを返す

先頭の1トークンだけで SQL 文の種類が確定するため、バックトラックは不要である。

---

### 2-3-4 CREATE TABLE パース

**この節で理解できること:** `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)` のような DDL がどのように Statement に変換されるか。

#### parseCreateTable() の流れ

```typescript
// src/sql/parser.ts:125-169
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
```

SQL `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)` を例に流れを追う。

```
トークン列: CREATE TABLE users ( id INTEGER PRIMARY KEY , name TEXT NOT NULL )

parse()  → currentToken = CREATE → parseCreateTable() を呼ぶ
         ① expectPeek(TABLE)  → peekToken = TABLE → 前進、currentToken = TABLE
         ② expectPeek(IDENT)  → peekToken = users(IDENT) → 前進、currentToken = users
            tableName = "users"
         ③ expectPeek(LPAREN) → peekToken = ( → 前進、currentToken = (
         ④ while ループ:
            peekToken = id(IDENT) → RPAREN でも EOF でもないので進む
            nextToken() → currentToken = id
            parseColumnDef() → { name: "id", type: "INTEGER", constraints: ["PRIMARY_KEY"] }
            peekToken = , → COMMA なので nextToken() でスキップ
            peekToken = name(IDENT) → RPAREN でも EOF でもないので進む
            nextToken() → currentToken = name
            parseColumnDef() → { name: "name", type: "TEXT", constraints: ["NOT_NULL"] }
            peekToken = ) → RPAREN なのでループを抜ける
         ⑤ expectPeek(RPAREN) → 前進
         ⑥ columns.length = 2 → OK
         ⑦ 結果を返す
```

#### parseColumnDef() — カラム名 + 型 + 制約

```typescript
// src/sql/parser.ts:171-216
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
```

`parseColumnDef()` は以下の3段階で処理する。

1. **カラム名**: `currentToken` が `IDENT` であることを確認し、`literal` を取得
2. **カラム型**: `nextToken()` で進めてから `parseColumnType()` で型を判定
3. **制約（0個以上）**: `peekToken` が `PRIMARY` / `NOT` / `UNIQUE` である限りループ
   - `PRIMARY` → 次に `KEY` が来れば `"PRIMARY_KEY"` を追加
   - `NOT` → 次に `NULL` が来れば `"NOT_NULL"` を追加
   - `UNIQUE` → 無条件に `"UNIQUE"` を追加

制約は `while` ループで処理されるため、1つのカラムに複数の制約を付けることができる（例: `id INTEGER PRIMARY KEY NOT NULL`）。

#### parseColumnType() — INT → INTEGER の正規化

```typescript
// src/sql/parser.ts:218-223
  private parseColumnType(): ColumnType | null {
    if (this.curTokenIs(TokenType.INTEGER_KW)) return "INTEGER";
    if (this.curTokenIs(TokenType.INT_KW)) return "INTEGER"; // INT → INTEGER に正規化
    if (this.curTokenIs(TokenType.TEXT_KW)) return "TEXT";
    return null;
  }
```

`INT` と `INTEGER` はどちらも `"INTEGER"` に正規化される。これにより、アプリケーション側では `ColumnType` が `"INTEGER"` か `"TEXT"` かだけを気にすればよい。認識できない型が指定された場合は `null` を返し、呼び出し元でエラーになる。

---

### 2-3-5 INSERT INTO パース

**この節で理解できること:** `INSERT INTO users (id, name) VALUES (1, 'Alice')` のような DML がどのように Statement に変換されるか。

#### parseInsert() の流れ

```typescript
// src/sql/parser.ts:229-275
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
```

SQL `INSERT INTO users (id, name) VALUES (1, 'Alice')` の処理フローは以下の通り。

```
トークン列: INSERT INTO users ( id , name ) VALUES ( 1 , 'Alice' )

parseInsert() を呼ぶ (currentToken = INSERT)
  ① expectPeek(INTO)   → 前進、currentToken = INTO
  ② expectPeek(IDENT)  → 前進、currentToken = users
     tableName = "users"
  ③ expectPeek(LPAREN) → 前進、currentToken = (
  ④ parseIdentifierList() → ["id", "name"]
  ⑤ expectPeek(RPAREN) → 前進、currentToken = )
  ⑥ expectPeek(VALUES) → 前進、currentToken = VALUES
  ⑦ expectPeek(LPAREN) → 前進、currentToken = (
  ⑧ parseValueList()   → { success: true, values: [1, "Alice"] }
  ⑨ expectPeek(RPAREN) → 前進、currentToken = )
  ⑩ 結果: { type: "INSERT", tableName: "users", columns: ["id", "name"], values: [1, "Alice"] }
```

#### parseIdentifierList() — カンマ区切りのカラム名

```typescript
// src/sql/parser.ts:277-294
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
```

パターンは典型的な **カンマ区切りリストのパース** である。

1. 最初の識別子を `expectPeek(IDENT)` で読む
2. `peekToken` が `COMMA` である限りループ
   - カンマをスキップ
   - 次の識別子を読む
3. 識別子の配列を返す

エラーの場合は `null` を返し、呼び出し元でエラーメッセージを生成する。

#### parseValueList() / parseValue()

```typescript
// src/sql/parser.ts:296-317
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
```

`parseValueList()` は `parseIdentifierList()` と似た構造だが、識別子ではなく **値**（文字列リテラルまたは数値リテラル）を読み取る点が異なる。

```typescript
// src/sql/parser.ts:443-455
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
```

`parseValue()` は現在のトークンから値を取り出す。

- `STRING` トークン → `literal` をそのまま `string` として返す
- `NUMBER` トークン → `Number()` で変換し、`NaN` でなく整数であれば `number` として返す
- それ以外 → `null`（エラー）

数値の変換で `Number.isInteger()` をチェックしているため、現時点では整数のみをサポートしている。

---

### 2-3-6 SELECT パース

**この節で理解できること:** `SELECT * FROM users WHERE id = 1 AND name = 'Alice'` のような DQL がどのように Statement に変換されるか。

#### parseSelect() の流れ

```typescript
// src/sql/parser.ts:323-367
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
```

#### ワイルドカード(*) vs カラム指定

`SELECT` の直後のトークンで分岐する。

- `ASTERISK` (`*`) → `columns` に `"*"` を追加して終了
- `IDENT` → カラム名を読み取り、カンマが続く限り追加のカラム名を読む

```sql
-- ワイルドカード
SELECT * FROM users
-- columns = ["*"]

-- カラム指定
SELECT id, name FROM users
-- columns = ["id", "name"]
```

#### parseWhereClause() / parseWhereCondition()

WHERE 句はオプションで、`peekToken` が `WHERE` の場合のみパースされる。

```typescript
// src/sql/parser.ts:373-392
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
```

`parseWhereClause()` は `AND` で結合された複数の条件を `Record<string, WhereCondition>` に集約する。

```typescript
// src/sql/parser.ts:394-418
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
```

1つの WHERE 条件は「カラム名 → 演算子 → 値」の3トークンで構成される。

#### parseOperator()

```typescript
// src/sql/parser.ts:420-437
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
```

`parseOperator()` は `currentToken` の `type` を演算子文字列にマッピングする。戻り値の型が `WhereCondition["operator"]` になっているため、`WhereCondition` の `operator` フィールドで許可された文字列リテラルのいずれかしか返せない。

---

### SELECT 構文解析のデータフロー例

SQL `SELECT id, name FROM users WHERE id >= 1 AND name = 'Alice';` の全体フローを追ってみよう。

**Step 1: Lexer によるトークン化**

```
[SELECT] [id] [,] [name] [FROM] [users] [WHERE] [id] [>=] [1] [AND] [name] [=] ['Alice'] [;] [EOF]
```

**Step 2: parse() ディスパッチ**

`currentToken = SELECT` → `parseSelect()` を呼ぶ。

**Step 3: parseSelect() — カラムリスト**

```
nextToken() → currentToken = id (IDENT)
columns = ["id"]
peekToken = , (COMMA) → ループ続行
  nextToken() → currentToken = ,
  nextToken() → currentToken = name (IDENT)
  columns = ["id", "name"]
peekToken = FROM → ループ終了
```

**Step 4: parseSelect() — FROM 句**

```
expectPeek(FROM) → 前進、currentToken = FROM
expectPeek(IDENT) → 前進、currentToken = users
tableName = "users"
```

**Step 5: parseSelect() — WHERE 句**

```
peekToken = WHERE → WHERE 句のパース開始
nextToken() → currentToken = WHERE

parseWhereClause():
  parseWhereCondition():
    expectPeek(IDENT) → 前進、currentToken = id
    column = "id"
    nextToken() → currentToken = >= (GTE)
    parseOperator() → ">="
    nextToken() → currentToken = 1 (NUMBER)
    parseValue() → 1
    → { column: "id", condition: { operator: ">=", value: 1 } }

  peekToken = AND → ループ続行
  nextToken() → currentToken = AND

  parseWhereCondition():
    expectPeek(IDENT) → 前進、currentToken = name
    column = "name"
    nextToken() → currentToken = = (EQ)
    parseOperator() → "="
    nextToken() → currentToken = Alice (STRING)
    parseValue() → "Alice"
    → { column: "name", condition: { operator: "=", value: "Alice" } }

  peekToken = ; → AND でないのでループ終了
```

**Step 6: 最終結果**

```typescript
{
  success: true,
  statement: {
    type: "SELECT",
    tableName: "users",
    columns: ["id", "name"],
    where: {
      id: { operator: ">=", value: 1 },
      name: { operator: "=", value: "Alice" }
    }
  }
}
```

この `Statement` オブジェクトが後続のストレージエンジン（3章以降）に渡され、実際のデータ操作が行われる。
