# ドキュメント作成計画

## 目的

本プロジェクト（SQLight — TypeScript/Bun版）の内部構造を、クエリーエンジンとストレージエンジンの2章構成で詳細に解説するドキュメントを `doc/` ディレクトリに作成する。

`specs/migration_plan.md` の移行方針（Phase 2: クエリーエンジン → Phase 3: ストレージエンジン → Phase 4: 統合）に沿った構成とし、各機能単位で節を分けて解説する。

---

## 出力先

```
doc/
├── chapter1_query_engine.md      # 1章：クエリーエンジン
└── chapter2_storage_engine.md    # 2章：ストレージエンジン
```

---

## 1章：クエリーエンジンの詳細解説

**対象ファイル:** `src/sql/token.ts`, `src/sql/lexer.ts`, `src/sql/parser.ts`

SQLの文字列を受け取り、内部表現（Statement オブジェクト）に変換するまでの処理を解説する。
「Go言語でつくるインタプリタ」のパターン（Token定義 → Lexer → Parser）を SQL向けに適用した設計であることを軸に説明する。

### 構成

```
1章 クエリーエンジン — SQL文字列から内部表現への変換

  1-1 全体アーキテクチャ
    - SQL文字列 → Lexer → Token列 → Parser → Statement の処理フロー図
    - 3ファイル (token.ts / lexer.ts / parser.ts) の役割分担
    - 「Go言語でつくるインタプリタ」のパターンとの対応関係

  1-2 トークン定義 (token.ts)
    1-2-1 トークンのカテゴリ設計
      - SpecialTokens (ILLEGAL, EOF)
      - SqlKeywords (CREATE, TABLE, SELECT, FROM, WHERE, AND, ...)
      - Operators (=, !=, >, <, >=, <=)
      - Delimiters ((, ), ,, ;, *)
      - Literals (IDENT, NUMBER, STRING)
      - スプレッドによる TokenType 統合と TypeScript の型推論
    1-2-2 Token クラスとキーワード判定
      - Token クラスの構造 (type + literal)
      - keywords マップによる「識別子 or キーワード」判定
      - lookupIdent() — 大文字小文字を無視したキーワード照合

  1-3 字句解析 (lexer.ts)
    1-3-1 Lexer の基本構造
      - dual-pointer パターン (position / readPosition / currentCharacter)
      - readChar() と peekChar() による文字読み取り
      - インタプリタ本のパターンとの対応
    1-3-2 nextToken() — トークン切り出しのメインループ
      - switch文による1文字トークンの処理 (, ), ,, ;, *, =
      - 2文字演算子の先読み (!=, >=, <=)
      - 識別子・数値・文字列への分岐 (default ケース)
    1-3-3 空白・コメントの処理
      - skipWhitespace() — スペース/タブ/改行のスキップ
      - skipLineComment() — SQL の「--」行コメント対応
      - skipWhitespaceAndComments() — コメントと空白の交互スキップ
    1-3-4 リテラルの読み取り
      - readIdentifier() — 英字/数字/アンダースコアの連続読み取り
      - readNumber() — 数字の連続読み取り
      - readString() — シングルクォート/ダブルクォート文字列
      - 文字判定ヘルパー isLetter() / isDigit()

  1-4 構文解析 (parser.ts)
    1-4-1 型定義 — Statement の種類
      - ColumnType, ColumnConstraint, ColumnDef — カラム定義
      - WhereCondition — WHERE句の条件式
      - CreateTableStatement / InsertStatement / SelectStatement — 3種のStatement
      - ParseResult — Result型パターンによるエラーハンドリング
    1-4-2 SqlParser クラスの基本構造
      - dual-token window (currentToken / peekToken)
      - nextToken(), curTokenIs(), peekTokenIs(), expectPeek() ヘルパー
      - インタプリタ本のパターンとの対応
    1-4-3 parse() — メインのディスパッチ
      - 先頭トークンで SQL文の種類を判別 (CREATE / INSERT / SELECT)
      - EOF チェック、未対応SQLのエラー処理
    1-4-4 CREATE TABLE のパース
      - CREATE → TABLE → テーブル名 → ( → カラム定義列 → ) の流れ
      - parseColumnDef() — カラム名 + 型 + 制約の解析
      - parseColumnType() — INTEGER / INT / TEXT の型判定と正規化
      - 制約 (PRIMARY KEY, NOT NULL, UNIQUE) のオプション解析
    1-4-5 INSERT INTO のパース
      - INSERT → INTO → テーブル名 → (カラムリスト) → VALUES → (値リスト) の流れ
      - parseIdentifierList() — カンマ区切りのカラム名列
      - parseValueList() / parseValue() — 数値リテラルと文字列リテラルの判定
    1-4-6 SELECT のパース
      - SELECT → カラムリスト(* or カラム名列) → FROM → テーブル名 → [WHERE] の流れ
      - ワイルドカード (*) とカラム指定の分岐
      - parseWhereClause() / parseWhereCondition() — WHERE句の解析
      - parseOperator() — 比較演算子の変換
      - AND による複数条件の連結
```

### 各節で含める内容

- **コード例**: 該当箇所の実際のコード抜粋（ファイル名と行番号付き）
- **データフロー**: 入力 SQL がどう変換されていくかの具体例
  - 例: `SELECT * FROM users WHERE id = 1;` のトークン列→Statement変換
- **設計判断の背景**: なぜその構造にしたのか（インタプリタ本のパターン適用理由など）

---

## 2章：ストレージエンジンの詳細解説

**対象ファイル:** `src/storage/pager.ts`, `src/db/btree.ts`, `src/db/database.ts`

Statement を受け取り、ディスク上のバイナリファイルに対して実際にデータの読み書きを行う部分を解説する。
Pager（ページ単位I/O） → B+Tree（データ構造） → Database（統合エンジン）の3層構造を軸に説明する。

### 構成

```
2章 ストレージエンジン — データの永続化と検索

  2-1 全体アーキテクチャ
    - Pager → B+Tree → Database の3層構造の図
    - Go版との違い (JSON永続化 → ページベースバイナリファイル)
    - 各ファイルの役割分担

  2-2 Pager — ページ単位のファイルI/O (pager.ts)
    2-2-1 型定義とページフォーマット
      - PageType (Unused / Schema / LeafNode / InternalNode)
      - FileHeader 構造 (magic / pageSize / totalPages / schemaPage)
      - ファイルヘッダーのバイナリレイアウト (オフセット表)
    2-2-2 Pager クラスの基本操作
      - open() — ファイル新規作成 or 既存ファイルの再オープン
      - 新規作成時の初期化: ヘッダーページ(0) + スキーマページ(1) の書き込み
      - 既存ファイル: ヘッダー読み込みとマジックナンバー検証
    2-2-3 ページの読み書き
      - readPage() / writePage() — ページ番号からファイルオフセットへの変換
      - allocatePage() — 新ページ割り当てと totalPages の更新
      - flushHeader() — ヘッダーページの書き戻し
      - close() — ファイルクローズ
    2-2-4 バイナリI/Oの詳細
      - Node.js の fs (openSync/readSync/writeSync/closeSync) の利用
      - Buffer を使ったバイナリデータの読み書き
      - リトルエンディアン (LE) でのデータ格納

  2-3 B+Tree — ページ上で動作するツリー構造 (btree.ts)
    2-3-1 型定義とページレイアウト
      - ColumnValue / BTreeRecord / BTreeResult — 基本型
      - リーフノードのバイナリレイアウト: ページタイプ + セル数 + 右兄弟 + セル配列
      - 内部ノードのバイナリレイアウト: ページタイプ + キー数 + 最左子 + (キー,子) ペア配列
      - NODE_HEADER_SIZE, INTERNAL_ENTRY_SIZE 定数
    2-3-2 B+Tree の生成と復元
      - create() — 新規ツリー作成 (空リーフノードを1ページ割り当て)
      - open() — 既存ツリーのルートページから復元
      - getRootPageNum() — ルートページ番号の取得
    2-3-3 レコードのシリアライズ/デシリアライズ
      - セル形式: key(u32) + valueCount(u16) + values(型タグ付き可変長)
      - 型タグ: 0x00=NULL / 0x01=INTEGER(i32) / 0x02=TEXT(長さプレフィックス+UTF-8)
      - readLeafCells() — ページバッファからレコード配列を復元
      - writeLeafCellsToBuffer() — レコード配列をページバッファに書き込み
    2-3-4 INSERT — パス追跡方式による挿入
      - findLeafPage() — ルートからリーフまでの経路(path)を記録しながら降下
      - リーフへのソート済み挿入と重複キーチェック
      - リーフオーバーフロー → splitLeafNode() によるリーフ分割
      - propagateSplit() — 昇格キーの親方向への伝播
      - splitInternalNode() — 内部ノードの分割
      - createNewRoot() — ルート分割時の新しいルート作成
      - 右兄弟ポインタの付け替え（リンクリスト維持）
    2-3-5 SEARCH — キーによる単一レコード検索
      - searchInNode() — ルートからリーフまで再帰的に探索
      - findChildPage() — 内部ノードでのキー比較による子ページ選択
    2-3-6 SCAN — 全レコードの順序付き取得
      - findLeftmostLeaf() — 最左リーフまで降下
      - 右兄弟ポインタを辿るリーフのリンクリスト走査
      - B+Tree の特性: リーフだけで全データにアクセス可能

  2-4 Database — クエリーエンジンとストレージエンジンの統合 (database.ts)
    2-4-1 型定義
      - Record 型 — カラム名→値のマップ
      - QueryResult — 実行結果の Result型パターン
      - TableSchema — テーブル名 + カラム定義 + ルートページ番号
    2-4-2 Database クラスの構造と初期化
      - open() — Pager オープン + スキーマ読み込み
      - tables (Map<string, TableSchema>) と btrees (Map<string, BTree>) のメモリキャッシュ
      - close() — Pager クローズ
    2-4-3 スキーマページのシリアライズ形式
      - テーブルエントリのバイナリレイアウト
        - テーブル名: u16(長さ) + UTF-8
        - カラム定義: カラム名 + 型タグ(u8) + 制約フラグ(u8, ビットフィールド)
        - ルートページ番号: u32
      - loadSchema() — スキーマページからテーブル情報を復元
      - saveSchema() — テーブル情報をスキーマページに書き出し
    2-4-4 CREATE TABLE の実行
      - テーブル名の重複チェック (case-insensitive)
      - PRIMARY KEY の個数制限 (最大1つ)
      - BTree.create() による新規 B+Tree 作成
      - スキーマページへの書き込み
    2-4-5 INSERT INTO の実行
      - テーブル存在チェック + カラム名検証
      - convertValue() — カラム型に基づく値の型変換
      - NOT NULL 制約チェック
      - PRIMARY KEY がない場合の auto-increment キー生成
      - BTree.insert() によるレコード挿入
      - ルートページ番号変更時のスキーマ更新
    2-4-6 SELECT の実行
      - BTree.scan() による全レコード取得
      - カラム名の大文字小文字無視マッチング
      - BTreeRecord → Record (カラム名→値マップ) への変換
      - WHERE フィルタリング — matchesCondition() による値比較
      - 型を跨いだ比較ロジック (数値 vs 文字列の自動変換)
      - カラムプロジェクション (指定カラムだけに絞る)
```

### 各節で含める内容

- **バイナリレイアウト図**: ページ内のバイト配置を表で明示
- **コード例**: 該当箇所の実際のコード抜粋（ファイル名と行番号付き）
- **具体的なデータ例**: INSERT/SELECT 時にディスク上でどうデータが配置されるか
  - 例: 5件のレコードを挿入した時のリーフ分割の様子
- **Go版との比較**: Go版でJSON永続化だったものがどうバイナリに変わったか

---

## 作業手順

1. `doc/` ディレクトリを作成
2. `doc/chapter1_query_engine.md` を作成（1章）
3. `doc/chapter2_storage_engine.md` を作成（2章）

---

## 注意事項

- コード抜粋には `ファイルパス:行番号` を記載し、読者が実際のソースに辿れるようにする
- 各節の冒頭に「この節で理解できること」を1行で示す
- 図はテキストベース（ASCII図 or Mermaid）で表現する
- 日本語で記述する
