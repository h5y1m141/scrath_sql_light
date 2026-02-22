# SQLight 調査レポート & 移行計画

## 1. リポジトリ概要の確認

### 理解の検証結果: 正しい

- **Go言語でSQLiteを自作したプロジェクト** — 確認済み
- **Web画面からSQLを実行して結果を表示できる** — 確認済み（`localhost:8081`）
- CLIからも利用可能（`cmd/main.go`）

---

## 2. プロジェクト構造

```
reference/
├── cmd/main.go                    # CLI エントリポイント
├── web/
│   ├── main.go                    # Webサーバー (gorilla/mux, :8081)
│   └── static/
│       ├── index.html             # メインHTML
│       ├── styles.css             # スタイル
│       └── script.js              # フロントエンドJS
├── pkg/
│   ├── interfaces/interfaces.go   # コア型定義 (Statement, Record, Result, Column, Database interface)
│   ├── db/
│   │   ├── database.go            # DBエンジン本体 (Execute, CRUD, トランザクション, 永続化)
│   │   ├── table.go               # テーブル操作 (Insert, 制約チェック)
│   │   ├── btree.go               # B+Tree + 単純BST 実装
│   │   ├── cursor.go              # レコードカーソル
│   │   ├── record.go              # Record構造体 (id, name のみ — 未使用の残骸？)
│   │   └── transaction.go         # Transaction構造体 (簡素な実装)
│   ├── sql/parser.go              # SQLパーサー (正規表現ベース)
│   ├── storage/disk.go            # ディスク永続化 (JSON形式、実際にはdatabase.goのsave/loadが使われている)
│   ├── logger/logger.go           # ロガー + テーブル表示
│   └── types/datatypes/types.go   # データ型定義 (INTEGER, TEXT, BOOLEAN, DATETIME)
├── tests/database_test.go         # テスト (ただしAPIが現在の実装と不一致)
├── examples/                      # SQLサンプルファイル
├── go.mod                         # Go 1.21.2, gorilla/mux依存
└── go.sum
```

---

## 3. コアロジック詳細 (`pkg/`)

### 3.1 interfaces/interfaces.go — 型定義の中核

全体を繋ぐ共通型を定義している。

| 型 | 役割 |
|---|---|
| `Statement` interface | SQLステートメントの共通インターフェース (`Type() string`) |
| `CreateStatement` | CREATE TABLE |
| `InsertStatement` | INSERT INTO |
| `SelectStatement` | SELECT (WHERE対応) |
| `DeleteStatement` | DELETE (WHERE対応) |
| `DropStatement` | DROP TABLE |
| `DescribeStatement` | DESCRIBE TABLE |
| `BeginTransactionStatement` | BEGIN TRANSACTION |
| `CommitStatement` / `RollbackStatement` | COMMIT / ROLLBACK |
| `Column` | カラム定義 (Name, Type, PrimaryKey, Nullable, Unique) |
| `Table` | テーブル (Name, Columns, Records) |
| `Record` | レコード (`Columns map[string]interface{}`) |
| `Result` | 操作結果 (Success, Message, Records, Columns, IsSelect) |
| `Database` interface | DB操作インターフェース (Execute, GetTables, Save, Load, トランザクション) |

### 3.2 sql/parser.go — SQLパーサー

**正規表現ベースの簡易パーサー**。AST生成などは行わない。

対応SQL:
- `CREATE TABLE name (col1 TYPE CONSTRAINT, ...)` — PRIMARY KEY, NOT NULL, UNIQUE対応
- `INSERT INTO name (col1, ...) VALUES (val1, ...)` — 文字列(シングルクォート)、数値対応
- `SELECT col1, ... FROM name WHERE col op val AND ...` — `=`, `>`, `<`, `>=`, `<=`, `!=` 対応
- `DELETE FROM name WHERE ...` — SELECT と同様の WHERE 対応
- `DROP TABLE name`
- `DESCRIBE name`
- `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`

**制限事項:**
- UPDATE文は未対応（パーサーレベル）
- JOIN/サブクエリなし
- OR条件なし（ANDのみ）
- ORDER BY / GROUP BY / LIMIT なし
- WHERE条件は `map[string]interface{}` で表現 → 同一カラムへの複数条件不可

### 3.3 db/database.go — DBエンジン本体（最重要ファイル）

`Database` 構造体:
- `tables map[string]*interfaces.Table` — メモリ上のテーブル群
- `mutex sync.RWMutex` — 並行アクセス制御
- `path string` — 永続化先のJSONファイルパス
- `inTransaction bool` + `snapshot` — トランザクション状態

**主要機能:**
1. **Execute()** — Statement型で分岐してCRUD実行
2. **executeCreate()** — PRIMARY KEY制約のバリデーション、テーブル作成
3. **executeInsert()** — NOT NULL / PRIMARY KEY / UNIQUE 制約チェック、型変換
4. **executeSelect()** — カラム大文字小文字無視の名前解決、WHERE フィルタリング
5. **executeDelete()** — WHERE条件付き削除（operator + value の map 形式）
6. **executeDescribe()** — テーブル構造表示
7. **executeDrop()** — テーブル削除
8. **トランザクション** — BEGIN時にdeep copy → COMMIT時にsave / ROLLBACK時にsnapshotを破棄

**永続化:**
- JSON形式 (`json.MarshalIndent` → `ioutil.WriteFile`)
- 各操作(INSERT, CREATE等)の度にsave()を呼ぶ

**注目点:**
- `compareValues()` — 型を跨いだ値比較(int, float64, string間)
- `compareWithOperator()` — WHERE条件の演算子対応比較
- `getColumnMap()` — 大文字小文字を無視したカラム名解決

### 3.4 db/btree.go — 2種類のツリー実装

**BTree (B+Tree):**
- `LeafNodeMaxRecords = 3`, `InternalNodeMaxKeys = 3`（テスト用の小さい値）
- Insert, Search, Delete, Scan 操作
- リーフノードのリンクリスト (`Next` ポインタ)
- ノード分割 (splitLeaf, splitInternal)

**BTreeSimple (BST — 二分探索木):**
- 単純な左右子ノードの再帰挿入/検索
- `Scan()` は中順走査 (in-order traversal)

**重要な観察:**
- **B+Tree / BST はどちらも `database.go` の Execute フローでは使われていない**
- 実際のデータは `interfaces.Table.Records` (スライス) に直接格納
- ツリーは実装はあるがメインのCRUDロジックとは統合されていない

### 3.5 db/table.go — テーブル操作

- `Table` 構造体は `interfaces.Table` とは別（`db`パッケージ内ローカル）
- Insert時の NOT NULL / PRIMARY KEY / UNIQUE チェック
- **しかし database.go は interfaces.Table を直接操作しているため、この table.go は実質的に未使用**

### 3.6 db/cursor.go — カーソル

- table.go の `Table` に対するイテレータ
- `Next()`, `Current()` で順次走査
- **table.go と同様、メインフローでは使われていない**

### 3.7 db/record.go — Recordの別定義

```go
type Record struct {
    Id   int    `json:"id"`
    Name string `json:"name"`
}
```
- `interfaces.Record` とは完全に別物
- **メインフローでは未使用**

### 3.8 db/transaction.go — Transaction構造体

- `Database` へのポインタを持つ
- `Begin()`, `Commit()`, `Rollback()` — ただし実質何もしない（フラグ切り替えのみ）
- **実際のトランザクションは database.go 内の snapshot ベースの実装が担当**

### 3.9 storage/disk.go — ディスク永続化

- `SaveToFile()`, `LoadFromFile()` — JSON形式
- `db.Database` の `Tables()`, `SetTables()` メソッドを使用
- **database.go 内に独自の save/load があるため、こちらも実質未使用**

### 3.10 types/datatypes/types.go — データ型

- INTEGER, TEXT, BOOLEAN, DATETIME の型定義
- `Validate()`, `Convert()`, `MarshalJSON()` メソッド
- `GetType()` で型名→型オブジェクト変換
- **database.go 内で直接型チェックしているため、メインフローでは未使用**

### 3.11 logger/logger.go — ロギング

- Debug/Info/Error レベルのログ出力
- `PrintTable()` — CLI用のテーブル整形表示
- **web/main.go では Go 標準の `log` を使用、cli も独自フォーマット**

---

## 4. Webインターフェース詳細 (`web/`)

### 4.1 web/main.go — Webサーバー

**技術スタック:**
- `gorilla/mux` ルーター
- ポート `:8081`

**エンドポイント:**

| メソッド | パス | 機能 |
|---|---|---|
| GET | `/` | index.html を返す |
| GET | `/static/*` | 静的ファイル配信 |
| POST | `/query` | SQL実行 → JSON結果返却 |
| GET | `/tables` | テーブル一覧を JSON で返す |

**`/query` の流れ:**
1. リクエストBody: `{"query": "SELECT * FROM users;"}`
2. `sql.Parse()` でパース
3. `database.Execute()` で実行
4. `database.Save()` で永続化
5. レスポンス: `{"success": true, "message": "...", "records": [...], "columns": [...]}`

### 4.2 web/static/index.html — メインページ

- サイドバー（テーブルリスト）+ メインエリア（クエリ入力 + 結果表示）
- CSS Grid レイアウト (`250px` サイドバー + 残り)

### 4.3 web/static/script.js — フロントエンド

**主要機能:**
- `executeQuery()` — `/query` に POST してSQL実行
- `createTable()` — 結果をHTMLテーブルとして描画
- `updateTableList()` — `/tables` からテーブル一覧を取得してサイドバー更新
- テーブル名クリック → `SELECT * FROM tableName;` を自動実行
- `Ctrl+Enter` / `Cmd+Enter` でクエリ実行

### 4.4 web/static/styles.css — スタイル

- CSS変数ベース
- レスポンシブ対応（768px以下でシングルカラム）
- ダーク/ライトモード切り替えは **未実装**（READMEには記載あり）

---

## 5. テスト (`tests/database_test.go`)

**重要な発見: テストは現在のコードと互換性がない**

テストで呼んでいるAPI:
- `db.NewDatabase(file)` — 引数1つ（現在のコードと一致）
- `database.CreateTable("users", []interfaces.ColumnDef{...})` — **`ColumnDef` は interfaces に存在しない**
- `database.InsertIntoTable("users", r1)` — **このメソッドは存在しない**
- `database.SelectFromTable("users")` — **このメソッドは存在しない**
- `database.UpdateTable(...)` — **このメソッドは存在しない**
- `database.DeleteFromTable(...)` — **このメソッドは存在しない**
- `database.FindInTable(...)` — **このメソッドは存在しない**
- `interfaces.NewRecord(...)` — **このコンストラクタは存在しない**
- `database.Execute("SQL string")` — **Execute は Statement を受け取る、string ではない**
- `database.Begin()` / `database.Commit()` / `database.Rollback()` — **これらのメソッドは存在しない**
- `database.Tables()` — **このメソッドは存在しない**

→ テストは **以前のバージョンのAPI** に対して書かれたもので、現在のコードベースでは動作しない。

---

## 6. 設計上の特徴と観察

### 使われているもの（実際のデータフロー）
1. `interfaces` パッケージの型定義
2. `sql/parser.go` — SQLパース
3. `db/database.go` — 全CRUD操作 + 永続化 + トランザクション
4. `web/main.go` + `static/*` — Webインターフェース
5. `cmd/main.go` — CLIインターフェース

### 実装済みだが未統合（or 未使用）
1. `db/btree.go` — B+Tree / BST実装があるが database.go と繋がっていない
2. `db/table.go` — 別の Table 構造体（interfaces.Table と重複）
3. `db/cursor.go` — table.go の Table 用カーソル
4. `db/record.go` — 固定フィールドの Record（interfaces.Record と重複）
5. `db/transaction.go` — Transaction構造体（database.go のスナップショット方式が実際に使用）
6. `storage/disk.go` — 別の永続化実装（database.go の save/load が実際に使用）
7. `types/datatypes/types.go` — 型システム（database.go で直接型チェック）
8. `logger/logger.go` — ロガー（直接使われていない）

### アーキテクチャ的な特徴
- **データはメモリ上の `map[string]*Table` にフラットに保持**（B-Treeは不使用）
- **永続化は JSON ファイル**（database.json）
- **毎操作ごとにファイル全体を書き出す**
- **テーブル/カラム名は大文字小文字を無視** (case-insensitive)
- **トランザクションは deep copy ベースのスナップショット方式**

---

## 7. 移行計画

### 7.1 技術スタック

| 項目 | 選定 |
|---|---|
| 言語 | TypeScript |
| ランタイム | Bun 1.1.9 |
| テスト | bun:test (Bun 組み込み) |
| CLI | Bun の標準入力 (readline 相当) |
| Web UI | 不要（今回のスコープ外） |

### 7.2 移行方針

- Go の `pkg/` 構造をなるべく踏襲した TypeScript ディレクトリ構成にする
- Go 固有のイディオム（多値返却エラー、ポインタレシーバ等）は TypeScript らしく書き換える
  - エラーハンドリング → Result 型 (`{ success: true, data } | { success: false, error }` パターン)
  - ポインタ → 参照渡し（オブジェクト）
  - 型定義は `type` を使用（`interface` は使わない）
  - 型定義は専用ディレクトリに分離せず、使用するファイルに直接記述する
  - sync.RWMutex → 不要（シングルスレッド）
- Go 側で未統合だった **B+Tree (btree.go)** は参考にしつつ、本来あるべき形でストレージエンジンに統合する
- Go 側の JSON 丸ごと永続化は採用せず、**ページベースのバイナリファイル**で永続化する

### 7.3 対応する SQL の範囲（初期スコープ）

| SQL | 対応 | 理由 |
|---|---|---|
| CREATE TABLE | o | テーブル作成がないとデータ登録できない |
| INSERT INTO | o | テストデータ登録に必要 |
| SELECT | o | メインのゴール |
| DELETE | x | 後回し |
| DROP TABLE | x | 後回し |
| DESCRIBE | x | 後回し |
| BEGIN/COMMIT/ROLLBACK | x | 後回し |

### 7.4 アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│  CLI (main.ts)                                  │
│  REPL: SQL入力 → 結果表示                        │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  SQL Parser (sql/parser.ts)                     │
│  SQL文字列 → Statement オブジェクト               │
│  対応: CREATE TABLE / INSERT INTO / SELECT       │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  Database Engine (db/database.ts)               │
│  Statement を受け取り、B+Tree / Pager を使って    │
│  CRUD 操作を実行                                 │
│  - executeCreate: スキーマをメタページに書き込み   │
│  - executeInsert: B+Tree にレコード挿入           │
│  - executeSelect: B+Tree を走査してレコード取得    │
└──────┬──────────────────────────────┬───────────┘
       │                              │
┌──────▼──────────┐  ┌───────────────▼───────────┐
│  B+Tree          │  │  Pager (storage/pager.ts) │
│ (db/btree.ts)    │  │  ページ番号 ↔ ファイル     │
│                  │  │  オフセットの変換           │
│  - insert        │  │  - readPage(pageNum)      │
│  - search        │  │  - writePage(pageNum,buf) │
│  - scan          │  │  - allocatePage()         │
│                  │  │                           │
│  Go の btree.go  │  │  ※ Go実装には無かった層     │
│  を参考に実装     │  │  　 新規で設計・実装        │
└──────┬──────────┘  └───────────────┬───────────┘
       │                              │
       └──────────────┬───────────────┘
                      │
         ┌────────────▼────────────────┐
         │  バイナリファイル (.db)       │
         │                             │
         │  [Header Page (0)]          │
         │    - マジックナンバー         │
         │    - ページサイズ             │
         │    - テーブル数               │
         │                             │
         │  [Schema Page (1)]          │
         │    - テーブル定義一覧         │
         │    - 各テーブルのルートページ  │
         │                             │
         │  [Data Pages (2...N)]       │
         │    - B+Tree ノード           │
         │    - リーフ: レコードデータ    │
         │    - 内部: キー + 子ページ番号 │
         └────────────────────────────┘
```

### 7.5 ページフォーマット設計

**ファイル全体:**
- 固定サイズページの連続（デフォルト 4096 bytes / ページ）
- ページ番号 0 から順番に並ぶ

**Page 0 — ファイルヘッダー:**
```
Offset  Size  Description
0       4     マジックナンバー "SQLT" (0x53514C54)
4       2     ページサイズ (デフォルト 4096)
6       4     総ページ数
10      4     スキーマページ番号 (通常 1)
```

**Page 1 — スキーマページ:**
```
Offset  Size  Description
0       1     ページタイプ (0x01 = Schema)
1       2     テーブル数
3       ...   テーブルエントリの配列:
                - テーブル名 (長さプレフィックス付き文字列)
                - カラム数
                - カラム定義の配列 (名前, 型, 制約フラグ)
                - B+Tree ルートページ番号
```

**Data Pages — B+Tree ノード:**
```
Offset  Size  Description
0       1     ページタイプ (0x02 = LeafNode / 0x03 = InternalNode)
1       2     セル数 (キー/レコード数)
3       4     右兄弟ページ番号 (リーフのみ、リンクリスト用。0 = なし)

--- リーフノードの場合 ---
7       ...   セルの配列:
                - キー (4 bytes, INTEGER)
                - レコードデータ (各カラムの値をシリアライズ)

--- 内部ノードの場合 ---
7       4     最左子ページ番号
11      ...   (キー, 子ページ番号) ペアの配列
```

**レコードのシリアライズ:**
```
各カラムについて:
  - 型タグ (1 byte): 0x00=NULL, 0x01=INTEGER, 0x02=TEXT
  - INTEGER: 4 bytes (int32, little-endian)
  - TEXT: 2 bytes (長さ) + N bytes (UTF-8文字列)
```

### 7.6 ディレクトリ構成（予定）

```
src/
├── sql/
│   └── parser.ts         # SQLパーサー + Statement 関連の型
├── storage/
│   └── pager.ts          # Pager: ページ単位のファイルI/O + ページ関連の型
├── db/
│   ├── btree.ts          # B+Tree: ページ上で動作するツリー構造
│   └── database.ts       # DBエンジン: Statement実行 + Column/Record/Result 等の型
└── main.ts               # CLIエントリポイント (REPL)
```

型の配置方針:

| 型 | 定義場所 | 理由 |
|---|---|---|
| `Statement`, `CreateStatement`, `InsertStatement`, `SelectStatement` | `sql/parser.ts` | パーサーが生成する型 |
| `Column`, `Record`, `Result`, `TableSchema` | `db/database.ts` | DBエンジンが扱う型 |
| `PageType`, `FileHeader` 等 | `storage/pager.ts` | ページI/O固有の型 |
| B+Tree ノード関連 | `db/btree.ts` | ツリー固有の型 |

Go との対応関係:

| Go (参考元) | TypeScript (移植先) | 備考 |
|---|---|---|
| `pkg/interfaces/interfaces.go` | 各ファイルに分散 | 専用ディレクトリは作らない |
| `pkg/sql/parser.go` | `src/sql/parser.ts` | CREATE/INSERT/SELECT のみ |
| `pkg/db/database.go` | `src/db/database.ts` | JSON永続化 → Pager経由に変更 |
| `pkg/db/btree.go` | `src/db/btree.ts` | Go実装を参考に統合版として実装 |
| (なし) | `src/storage/pager.ts` | **新規**: ページベースI/O |
| `cmd/main.go` | `src/main.ts` | CLIのみ |

### 7.7 テスト方針

- **各タスクの実装とユニットテストはセット**で行う（実装だけ先に進めない）
- テストファイルは対象ファイルと同階層に `*.test.ts` として配置
- テストランナーは `bun:test` を使用

テストファイルの配置:
```
src/
├── sql/
│   ├── parser.ts
│   └── parser.test.ts        # パーサーのユニットテスト
├── storage/
│   ├── pager.ts
│   └── pager.test.ts         # Pager のユニットテスト
├── db/
│   ├── btree.ts
│   ├── btree.test.ts         # B+Tree のユニットテスト
│   ├── database.ts
│   └── database.test.ts      # DBエンジンのユニットテスト (結合テスト含む)
└── main.ts
```

### 7.8 実装タスク

#### Phase 1: プロジェクト基盤
- [ ] **T1** Bun プロジェクト初期化 (`bun init`, tsconfig.json)

#### Phase 2: クエリエンジン — SQL → 内部構造への変換が動くところまで
- [ ] **T2** `src/sql/parser.ts` + `src/sql/parser.test.ts`
  - 実装: SQLパーサー + Statement型定義 (CREATE TABLE, INSERT INTO, SELECT + WHERE)
  - テスト:
    - CREATE TABLE 文のパース (カラム名, 型, 制約)
    - INSERT INTO 文のパース (文字列値, 数値)
    - SELECT 文のパース (*, カラム指定, WHERE条件, 複数AND)
    - 不正なSQL文のエラーケース
- [ ] **T3** `src/main.ts` (v1) — CLI REPL の初版。SQL入力 → パース → Statement構造をCLIに表示
  - 例: `SELECT * FROM users WHERE id = 1;` と入力すると以下のように表示:
    ```
    Parsed: {
      type: "SELECT",
      tableName: "users",
      columns: ["*"],
      where: { id: { operator: "=", value: 1 } }
    }
    ```
  - この時点ではストレージエンジンなし。パーサーの動作確認が目的

**--- checkpoint 1: `bun test src/sql/` が全て通る + CLI でパース結果を目視確認 ---**

#### Phase 3: ストレージエンジン — ページベースI/O + B+Tree
- [ ] **T4** `src/storage/pager.ts` + `src/storage/pager.test.ts`
  - 実装: Pager + ページ関連型 (ページ読み書き, ページ割り当て, ファイルヘッダー管理)
  - テスト:
    - 新規ファイル作成時のヘッダー書き込み/読み込み
    - ページ割り当て (allocatePage) でページ番号が連番で返ること
    - writePage → readPage のラウンドトリップ
    - ファイルを閉じて再オープンしてもデータが残ること
- [ ] **T5** `src/db/btree.ts` + `src/db/btree.test.ts`
  - 実装: B+Tree + ノード関連型 (Pager上で動作。insert, search, scan)
  - テスト:
    - 単一レコードの insert → search
    - 複数レコード insert → scan で全件取得 (順序確認)
    - ノード分割が発生するケース (LeafNodeMaxRecords 超え)
    - 存在しないキーの search → null
    - ファイル再オープン後も B+Tree のデータが残存

**--- checkpoint 2: `bun test src/storage/ src/db/btree` が全て通る ---**

#### Phase 4: DBエンジン統合 — クエリエンジン + ストレージエンジンを接続
- [ ] **T6** `src/db/database.ts` + `src/db/database.test.ts`
  - 実装: DBエンジン + DB関連型 (パーサー + B+Tree + Pager を統合して CRUD 実行)
  - テスト:
    - CREATE TABLE → テーブルが作成されること
    - INSERT INTO → レコードが格納されること
    - SELECT * → 全レコードが返ること
    - SELECT WHERE → 条件に合うレコードだけ返ること
    - 重複テーブル作成のエラー
    - 存在しないテーブルへの操作のエラー
    - DB再起動後もデータが残ること (永続化の結合テスト)
- [ ] **T7** `src/main.ts` (v2) — CLI REPL の完成版。SQL入力 → パース → 実行 → 結果表示
  - `CREATE TABLE users (id INTEGER, name TEXT);` → "Table created"
  - `INSERT INTO users (id, name) VALUES (1, 'Alice');` → "1 row inserted"
  - `SELECT * FROM users;` → テーブル形式で結果表示

**--- checkpoint 3: `bun test` が全て通る + CLI で CREATE → INSERT → SELECT が動作 ---**

### 7.9 各タスクの依存関係

```
Phase 1    Phase 2                 ckpt1    Phase 3                     ckpt2    Phase 4                  ckpt3
T1 ──→ T2(parser+test) → T3(CLI v1) → [確認] → T4(pager+test) → T5(btree+test) → [確認] → T6(db+test) → T7(CLI v2) → [確認]
```

ポイント:
- 全タスクが一直線。各 checkpoint で `bun test` を実行して通ることを確認してから次へ
- 実装とテストは常にセット。テストが通らない状態で次のタスクに進まない
- Phase 2 完了時: パーサーのユニットテスト通過 + CLI で目視確認
- Phase 3 完了時: Pager + B+Tree のユニットテスト通過
- Phase 4 完了時: 全テスト通過 + CLI で一連のSQL操作が動作
