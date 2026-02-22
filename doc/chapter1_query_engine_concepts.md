# 1章: クエリーエンジンの概念

> **この章で理解できること:** SQL文字列がプログラムで処理できるデータ構造に変わるまでの仕組み。コードの詳細に入る前に、全体像と各ステップの役割を図解で把握する。

> **この章の概念を理解済みなら → [2章: クエリーエンジンの実装詳細](./chapter2_query_engine_impl.md) に進んでください**

---

## 1-1 クエリーエンジンとは何か

### SQL は「人間のための言葉」

```sql
SELECT * FROM users WHERE id = 1;
```

この SQL 文は人間にとっては読みやすいですが、プログラムにとっては単なる **1本の文字列** にすぎません。

```
"SELECT * FROM users WHERE id = 1;"
```

プログラムがこの文字列を理解して「usersテーブルからid=1のレコードを探す」という処理を行うためには、文字列を **意味のあるデータ構造** に変換する必要があります。この変換を担当するのが **クエリーエンジン** です。

### 2段階の変換

クエリーエンジンは、文字列を一気にデータ構造にするのではなく、**2段階** に分けて変換します。

```
┌──────────────────────────────────────────────────────────┐
│                    クエリーエンジン                         │
│                                                          │
│   SQL文字列                                               │
│   "SELECT * FROM users WHERE id = 1;"                    │
│          │                                               │
│          ▼                                               │
│   ┌─────────────┐                                        │
│   │  ① Lexer     │  字句解析                              │
│   │  (字句解析器)  │  文字列を「単語」に分割                  │
│   └──────┬──────┘                                        │
│          │                                               │
│          ▼                                               │
│   トークン列                                              │
│   [SELECT] [*] [FROM] [users] [WHERE] [id] [=] [1] [;]  │
│          │                                               │
│          ▼                                               │
│   ┌─────────────┐                                        │
│   │  ② Parser    │  構文解析                              │
│   │  (構文解析器)  │  「単語」を意味のある構造に組み立て       │
│   └──────┬──────┘                                        │
│          │                                               │
│          ▼                                               │
│   Statement オブジェクト                                   │
│   {                                                      │
│     type: "SELECT",                                      │
│     tableName: "users",                                  │
│     columns: ["*"],                                      │
│     where: { id: { operator: "=", value: 1 } }          │
│   }                                                      │
└──────────────────────────────────────────────────────────┘
```

**なぜ2段階に分けるのか？**

- **責務の分離**: 「文字をどう読むか」と「文法をどう解釈するか」は別の問題
- **テスタビリティ**: 各段階を個別にテストできる
- **拡張性**: 新しい SQL 構文を追加する時に、変更箇所が明確になる

この設計は「[Go言語でつくるインタプリタ](https://www.oreilly.co.jp/books/9784873118222/)」のパターンを SQL 向けに適用したものです。

---

## 1-2 字句解析（Lexer）の概念

### トークンとは

**トークン**（Token）は、SQL文字列の中で意味を持つ最小単位です。日本語に例えると「単語」に相当します。

```
SQL文字列:  SELECT * FROM users WHERE id = 1;

            ↓ 字句解析 ↓

トークン列:
  ┌────────┐ ┌───┐ ┌────┐ ┌─────┐ ┌─────┐ ┌──┐ ┌───┐ ┌───┐ ┌───┐
  │ SELECT │ │ * │ │FROM│ │users│ │WHERE│ │id│ │ = │ │ 1 │ │ ; │
  └────────┘ └───┘ └────┘ └─────┘ └─────┘ └──┘ └───┘ └───┘ └───┘
   キーワード 区切り キーワード 識別子  キーワード 識別子 演算子  数値   区切り
```

### トークンの5つの種類

| 種類 | 意味 | 例 |
|---|---|---|
| **キーワード** | SQL の予約語 | `SELECT`, `FROM`, `WHERE`, `CREATE`, `TABLE`, `INSERT`, `INTO`, `VALUES`, `AND` |
| **識別子** | テーブル名やカラム名 | `users`, `id`, `name`, `email` |
| **リテラル** | 値そのもの | `1` (数値), `'Alice'` (文字列) |
| **演算子** | 比較操作 | `=`, `!=`, `>`, `<`, `>=`, `<=` |
| **区切り文字** | 構造を区切る記号 | `(`, `)`, `,`, `;`, `*` |

### Lexer の動き方 — 1文字ずつ読む

Lexer は SQL 文字列を **左から右へ1文字ずつ** 読みながら、トークンを切り出していきます。

```
入力: "SELECT * FROM users"

位置:  S E L E C T   *   F R O M   u s e r s
       ↑
       現在位置

→ 英字が続く間読み進める → "SELECT" → キーワードと判定
```

```
位置:  S E L E C T   *   F R O M   u s e r s
                     ↑
                     現在位置

→ "*" → 区切り文字(ASTERISK)と判定
```

```
位置:  S E L E C T   *   F R O M   u s e r s
                         ↑
                         現在位置

→ 英字が続く間読み進める → "FROM" → キーワードと判定
```

### dual-pointer パターン — 2つのポインタで位置を追跡

Lexer は **2つのポインタ** を使って文字列を読み進めます。

```
入力: "WHERE id >= 5"

      W H E R E   i d   > =   5
      ↑ ↑
      │ └── readPosition (次に読む位置)
      └──── position (現在の位置)

">" を読んだ後、次の文字を「先読み」して ">=" なのか ">" だけなのかを判定

      W H E R E   i d   > =   5
                         ↑ ↑
                         │ └── readPosition で "=" を先読み → ">=" と判定
                         └──── position
```

この先読み（peek）が必要な場面:
- `>` → 次が `=` なら `>=`、そうでなければ `>`
- `<` → 次が `=` なら `<=`、そうでなければ `<`
- `!` → 次が `=` なら `!=`、そうでなければエラー

### 空白・コメントのスキップ

Lexer はトークン間の空白やコメントを自動的に読み飛ばします。

```
入力: "-- テーブル取得
       SELECT * FROM users"

  "--" を検出 → 行末までスキップ
  → 次のトークンは "SELECT" から始まる
```

---

## 1-3 構文解析（Parser）の概念

### トークン列から構造を読み取る

Parser は Lexer が作ったトークン列を受け取り、**SQL文の種類と構成要素** を認識して、プログラムが扱えるオブジェクト（Statement）を組み立てます。

```
トークン列:
  [CREATE] [TABLE] [users] [(] [id] [INTEGER] [PRIMARY] [KEY] [,]
  [name] [TEXT] [NOT] [NULL] [)] [;]

          ↓ 構文解析 ↓

Statement オブジェクト:
  {
    type: "CREATE_TABLE",
    tableName: "users",
    columns: [
      { name: "id",   type: "INTEGER", constraints: ["PRIMARY_KEY"] },
      { name: "name", type: "TEXT",    constraints: ["NOT_NULL"] }
    ]
  }
```

### 3種類の Statement

本プロジェクトでは3種類のSQLに対応しており、それぞれ異なる構造の Statement を生成します。

**CREATE TABLE — テーブルを作る**
```
SQL:       CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
                  ↓
取り出す情報: テーブル名 = "users"
              カラム = [
                { 名前: "id",   型: INTEGER, 制約: [PRIMARY_KEY] },
                { 名前: "name", 型: TEXT,    制約: [] }
              ]
```

**INSERT INTO — データを入れる**
```
SQL:       INSERT INTO users (id, name) VALUES (1, 'Alice');
                  ↓
取り出す情報: テーブル名 = "users"
              カラム列 = ["id", "name"]
              値列     = [1, "Alice"]
```

**SELECT — データを取り出す**
```
SQL:       SELECT name FROM users WHERE id > 0 AND name = 'Alice';
                  ↓
取り出す情報: テーブル名 = "users"
              取得カラム = ["name"]
              WHERE条件 = {
                id:   { 演算子: ">", 値: 0 },
                name: { 演算子: "=", 値: "Alice" }
              }
```

### dual-token window — 2つのトークンを見ながら進む

Parser は **現在のトークン** と **次のトークン** の2つを常に保持しながら解析を進めます。これは Lexer の dual-pointer と同じ考え方の、トークンレベル版です。

```
トークン列: [SELECT] [*] [FROM] [users] [WHERE] [id] [=] [1]

ステップ1:
  currentToken = [SELECT]    ← 今見ているトークン
  peekToken    = [*]         ← 次のトークン（先読み）
  → "SELECT" だ → SELECT文の解析に入る

ステップ2: (nextToken() で1つ進む)
  currentToken = [*]
  peekToken    = [FROM]
  → "*" だ → 全カラム指定

ステップ3:
  currentToken = [FROM]
  peekToken    = [users]
  → 次が識別子(テーブル名) であることを先読みで確認

ステップ4:
  currentToken = [users]
  peekToken    = [WHERE]
  → テーブル名 = "users"
  → 次が WHERE → WHERE句の解析に入る

  ... 以降、WHERE条件の解析が続く
```

**先読みが必要な場面の例:**

```
SELECT の後のトークンを見て分岐:
  currentToken = [SELECT]
  peekToken    = [*]      → SELECT * (全カラム)
  peekToken    = [IDENT]  → SELECT name, id, ... (特定カラム)
```

```
WHERE 句があるかの判定:
  ... FROM users の後 ...
  peekToken = [WHERE]     → WHERE句がある → 条件解析に進む
  peekToken = [;] or [EOF] → WHERE句なし → 解析完了
```

### expectPeek — 「次はこのトークンのはず」

Parser でよく使われるパターンが `expectPeek()` です。「次のトークンが期待通りか確認し、そうなら進む」という動作をします。

```
INSERT INTO の解析:

  currentToken = [INSERT]

  expectPeek(INTO)   → 次は "INTO" か？ → YES → 進む
  expectPeek(IDENT)  → 次は識別子か？   → YES → テーブル名を取得
  expectPeek(LPAREN) → 次は "(" か？    → YES → カラムリストの解析に入る

  もし expectPeek が NO なら → 構文エラーを返す
```

---

## 1-4 全体フロー図 — 具体例で追う

`SELECT * FROM users WHERE id = 1;` を最初から最後まで追います。

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: 入力                                                 │
│                                                             │
│   "SELECT * FROM users WHERE id = 1;"                       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Step 2: Lexer (字句解析)                                     │
│                                                             │
│   文字を1つずつ読み、トークンに分割:                            │
│                                                             │
│   "S","E","L","E","C","T" → SELECT (キーワード)              │
│   " "                     → スキップ                         │
│   "*"                     → ASTERISK (区切り文字)             │
│   " "                     → スキップ                         │
│   "F","R","O","M"         → FROM (キーワード)                │
│   " "                     → スキップ                         │
│   "u","s","e","r","s"     → "users" (識別子)                 │
│   " "                     → スキップ                         │
│   "W","H","E","R","E"     → WHERE (キーワード)               │
│   " "                     → スキップ                         │
│   "i","d"                 → "id" (識別子)                    │
│   " "                     → スキップ                         │
│   "="                     → EQ (演算子)                      │
│   " "                     → スキップ                         │
│   "1"                     → 1 (数値リテラル)                  │
│   ";"                     → SEMICOLON (区切り文字)            │
│                                                             │
│   結果: [SELECT, *, FROM, users, WHERE, id, =, 1, ;, EOF]  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Step 3: Parser (構文解析)                                    │
│                                                             │
│   [SELECT] → SELECT文だ！                                    │
│     → [*] → 全カラム指定 (columns: ["*"])                    │
│     → [FROM] → OK                                           │
│     → [users] → テーブル名 (tableName: "users")              │
│     → [WHERE] → WHERE句がある！                              │
│       → [id] [=] [1] → 条件 (id: { operator: "=", value: 1 }) │
│     → [;] → 文の終わり                                       │
│                                                             │
│   結果:                                                      │
│   {                                                         │
│     type: "SELECT",                                         │
│     tableName: "users",                                     │
│     columns: ["*"],                                         │
│     where: {                                                │
│       id: { operator: "=", value: 1 }                       │
│     }                                                       │
│   }                                                         │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Step 4: この Statement がストレージエンジンに渡される           │
│         → 3章・4章で解説                                      │
└─────────────────────────────────────────────────────────────┘
```

### 本プロジェクトのファイル構成

```
src/sql/
├── token.ts    ← トークンの種類を定義 (TokenType, Token クラス)
├── lexer.ts    ← 字句解析器 (SQL文字列 → トークン列)
└── parser.ts   ← 構文解析器 (トークン列 → Statement) + 型定義
```

各ファイルの実装詳細は → [2章: クエリーエンジンの実装詳細](./chapter2_query_engine_impl.md)
