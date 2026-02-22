# SQLight (TypeScript / Bun)

Go言語で実装された SQLite クローン [venkat1017/SQLight](https://github.com/venkat1017/SQLight) を参考に、Bun / TypeScript で再実装したプロジェクトです。

RDB の内部構造（SQL パーサー、B+Tree、ページベースのバイナリストレージ）を学ぶことを目的としています。

## 機能

- **SQL パーサー** — `CREATE TABLE` / `INSERT INTO` / `SELECT` (WHERE + AND 対応)
- **B+Tree インデックス** — キー順序付きデータ管理、ノード分割
- **ページベースストレージ** — 4KB 固定ページ単位のバイナリファイル I/O
- **永続化** — プロセス終了後もデータが保持される
- **CLI (REPL)** — 対話的に SQL を実行して結果を確認

## 必要環境

- [Bun](https://bun.sh/) 1.1 以上

## セットアップ

```bash
bun install
```

## 使い方

```bash
bun run src/main.ts
```

REPL が起動するので、SQL 文を入力してください（セミコロン `;` で実行）。

```
> CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);
Table 'users' created

> INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com');
1 row inserted

> INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com');
1 row inserted

> SELECT * FROM users;
+----+-------+-------------------+
| id | name  | email             |
+----+-------+-------------------+
| 1  | Alice | alice@example.com |
| 2  | Bob   | bob@example.com   |
+----+-------+-------------------+
(2 rows)

> SELECT name FROM users WHERE id > 1;
+------+
| name |
+------+
| Bob  |
+------+
(1 row)
```

`Ctrl+D` で終了します。データは `sqlight.db` に保存され、次回起動時に自動で読み込まれます。

### 対応 SQL

| SQL | 例 |
|---|---|
| CREATE TABLE | `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);` |
| INSERT INTO | `INSERT INTO t (id, name) VALUES (1, 'Alice');` |
| SELECT | `SELECT * FROM t WHERE id > 0 AND name = 'Alice';` |

## テスト

```bash
bun test
```

レイヤーごとに実行する場合:

```bash
bun test src/sql/         # SQL パーサー
bun test src/storage/     # Pager (ページ I/O)
bun test src/db/btree     # B+Tree
bun test src/db/database  # DB エンジン (結合テスト含む)
```

## 実装について

本プロジェクトの設計・実装には [Claude Code](https://claude.ai/claude-code) を使用しました。調査結果や設計方針の詳細は [specs/migration_plan.md](specs/migration_plan.md) にまとめています。
