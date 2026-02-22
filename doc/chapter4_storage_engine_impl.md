# 4章: ストレージエンジンの実装詳細

> **概念的な背景 (Pager / B+Tree / スキーマの役割分担など) については [3章: ストレージエンジンの概念](./chapter3_storage_engine_concepts.md) を参照してください。**

本章では、3章で解説した概念を TypeScript/Bun でどのように実装しているかを、コードレベルで詳しく追いかけます。対象ファイルは以下の3つです。

| ファイル | 役割 |
|---|---|
| `src/storage/pager.ts` | ページ単位のファイルI/O |
| `src/db/btree.ts` | B+Tree (ページ上で動作するツリー構造) |
| `src/db/database.ts` | クエリーエンジンとストレージエンジンの統合 |

---

## 4-1 Pager (`pager.ts`)

### 4-1-1 型定義とページフォーマット

> **この節で理解できること:** ページの種類とファイルヘッダーのバイナリ構造。

#### PageType

ページの用途を 1 バイトで識別する型です。

```typescript
// src/storage/pager.ts:8-12
export type PageType =
  | 0x00   // Unused
  | 0x01   // Schema
  | 0x02   // LeafNode
  | 0x03;  // InternalNode
```

各値は `PAGE_TYPE` 定数オブジェクトとして名前付きで参照できます。

```typescript
// src/storage/pager.ts:14-19
export const PAGE_TYPE = {
  UNUSED: 0x00 as PageType,
  SCHEMA: 0x01 as PageType,
  LEAF_NODE: 0x02 as PageType,
  INTERNAL_NODE: 0x03 as PageType,
} as const;
```

| 値 | 名前 | 用途 |
|---|---|---|
| `0x00` | Unused | 未使用ページ |
| `0x01` | Schema | テーブル定義情報を格納 |
| `0x02` | LeafNode | B+Tree のリーフノード (実データ) |
| `0x03` | InternalNode | B+Tree の内部ノード (ルーティング) |

#### FileHeader 構造

ファイルの先頭ページ (ページ0) に書かれるメタデータです。

```typescript
// src/storage/pager.ts:21-26
export type FileHeader = {
  magic: number;         // 0x53514C54 ("SQLT")
  pageSize: number;      // デフォルト 4096
  totalPages: number;    // ファイル内の総ページ数
  schemaPage: number;    // スキーマページ番号 (通常 1)
};
```

#### ファイルヘッダーのバイナリレイアウト

ヘッダーは合計 14 バイトの固定長フィールドで構成されます。すべてリトルエンディアンです。

| オフセット | サイズ | 型 | フィールド名 | 説明 |
|---|---|---|---|---|
| 0 | 4 | u32 | magic | マジックナンバー `0x53514C54` (ASCII "SQLT") |
| 4 | 2 | u16 | pageSize | ページサイズ (バイト単位、デフォルト 4096) |
| 6 | 4 | u32 | totalPages | ファイル内の総ページ数 |
| 10 | 4 | u32 | schemaPage | スキーマページの番号 (通常 1) |

定数定義は以下の通りです。

```typescript
// src/storage/pager.ts:39-48
const HEADER_MAGIC_OFFSET = 0;
const HEADER_MAGIC_SIZE = 4;
const HEADER_PAGE_SIZE_OFFSET = 4;
const HEADER_PAGE_SIZE_SIZE = 2;
const HEADER_TOTAL_PAGES_OFFSET = 6;
const HEADER_TOTAL_PAGES_SIZE = 4;
const HEADER_SCHEMA_PAGE_OFFSET = 10;
const HEADER_SCHEMA_PAGE_SIZE = 4;
const FILE_HEADER_SIZE = 14;
```

**具体例:** 新規データベース作成直後のヘッダーページ (先頭14バイト)

```
オフセット  バイト列(LE)            値
0x00        54 4C 51 53            magic = 0x53514C54
0x04        00 10                  pageSize = 4096
0x06        02 00 00 00            totalPages = 2
0x0A        01 00 00 00            schemaPage = 1
```

---

### 4-1-2 基本操作 (open / close)

> **この節で理解できること:** データベースファイルの新規作成と既存ファイルの再オープンの分岐ロジック。

#### open() -- 新規ファイル作成 or 既存ファイル再オープン

`Pager.open()` は静的ファクトリメソッドです。ファイルの存在有無で処理を分岐します。

```typescript
// src/storage/pager.ts:68-110
static open(filePath: string, pageSize = DEFAULT_PAGE_SIZE): PagerResult<Pager> {
    const isNew = !existsSync(filePath);

    // ファイルを開く (読み書きモード、なければ作成)
    const fd = openSync(filePath, isNew ? "w+" : "r+");

    if (isNew) {
      // 新規ファイル: ヘッダーとスキーマページを初期化
      const header: FileHeader = {
        magic: MAGIC_NUMBER,
        pageSize,
        totalPages: 2, // ヘッダーページ(0) + スキーマページ(1)
        schemaPage: 1,
      };

      const pager = new Pager(fd, header);

      // ページ0: ファイルヘッダーを書き込み
      const headerPage = Buffer.alloc(pageSize, 0);
      writeFileHeader(headerPage, header);
      pager.writePageRaw(0, headerPage);

      // ページ1: スキーマページを空で初期化
      const schemaPage = Buffer.alloc(pageSize, 0);
      schemaPage.writeUInt8(PAGE_TYPE.SCHEMA, 0);  // ページタイプ
      schemaPage.writeUInt16LE(0, 1);                // テーブル数 = 0
      pager.writePageRaw(1, schemaPage);

      return { success: true, data: pager };
    }

    // 既存ファイル: ヘッダーを読み込み
    const headerBuf = Buffer.alloc(pageSize);
    readSync(fd, headerBuf, 0, pageSize, 0);

    const headerResult = readFileHeader(headerBuf);
    if (!headerResult.success) {
      closeSync(fd);
      return headerResult;
    }

    return { success: true, data: new Pager(fd, headerResult.data) };
  }
```

**新規作成時のフロー:**

1. `existsSync()` がファイル不在を検知
2. `openSync(filePath, "w+")` で読み書きモードで新規作成
3. ヘッダーオブジェクトを生成 (`totalPages: 2`, `schemaPage: 1`)
4. ページ0: `writeFileHeader()` でヘッダーをバイナリ化し `writePageRaw()` で書き込み
5. ページ1: ページタイプ=`0x01`(Schema)、テーブル数=0 の空スキーマページを書き込み

**既存ファイル再オープンのフロー:**

1. `openSync(filePath, "r+")` で読み書きモードでオープン
2. ページ0を `readSync()` で読み込み
3. `readFileHeader()` でマジックナンバーを検証 (`0x53514C54` と一致するか)
4. 不一致ならエラーを返し、ファイルディスクリプタを閉じる

#### close() -- ヘッダー書き戻し + ファイルクローズ

```typescript
// src/storage/pager.ts:177-180
close(): void {
    this.flushHeader();
    closeSync(this.fd);
  }
```

クローズ時に `flushHeader()` を呼び、メモリ上の `totalPages` などの最新値をファイルに反映してから `closeSync()` でファイルディスクリプタを解放します。

---

### 4-1-3 ページ読み書き

> **この節で理解できること:** ページ番号からファイルオフセットへの変換とバリデーションの仕組み。

#### readPage(pageNum) -- ページ番号からバッファへの読み込み

```typescript
// src/storage/pager.ts:132-142
readPage(pageNum: number): PagerResult<Buffer> {
    if (pageNum < 0 || pageNum >= this.header.totalPages) {
      return { success: false, error: `Page ${pageNum} out of range (0..${this.header.totalPages - 1})` };
    }

    const buf = Buffer.alloc(this.pageSize);
    const offset = pageNum * this.pageSize;
    readSync(this.fd, buf, 0, this.pageSize, offset);

    return { success: true, data: buf };
  }
```

**変換式:** `ファイルオフセット = pageNum * pageSize`

たとえば `pageSize = 4096` のとき:
- ページ0: オフセット 0
- ページ1: オフセット 4096
- ページ2: オフセット 8192

ページ番号が `0..totalPages-1` の範囲外ならエラーを返します。

#### writePage(pageNum, data) -- バリデーション付き書き込み

```typescript
// src/storage/pager.ts:147-158
writePage(pageNum: number, data: Buffer): PagerResult<void> {
    if (pageNum < 0 || pageNum >= this.header.totalPages) {
      return { success: false, error: `Page ${pageNum} out of range (0..${this.header.totalPages - 1})` };
    }

    if (data.length !== this.pageSize) {
      return { success: false, error: `Buffer size ${data.length} does not match page size ${this.pageSize}` };
    }

    this.writePageRaw(pageNum, data);
    return { success: true, data: undefined };
  }
```

2つのバリデーションを行います:

1. **範囲チェック:** ページ番号が `0..totalPages-1` の範囲内か
2. **サイズチェック:** 渡されたバッファのサイズがページサイズと一致するか

バリデーションに通過したら `writePageRaw()` に委譲します。

#### allocatePage() -- 新しいページの割り当て

```typescript
// src/storage/pager.ts:115-127
allocatePage(): PagerResult<number> {
    const pageNum = this.header.totalPages;
    this.header.totalPages++;

    // 新しいページをゼロ初期化して書き込み
    const emptyPage = Buffer.alloc(this.pageSize, 0);
    this.writePageRaw(pageNum, emptyPage);

    // ヘッダーページを更新
    this.flushHeader();

    return { success: true, data: pageNum };
  }
```

**フロー:**

1. 現在の `totalPages` を新ページ番号として取得
2. `totalPages` をインクリメント
3. ゼロ埋めされた空ページをファイルに書き込み
4. `flushHeader()` でヘッダーページ (ページ0) を更新
5. 新ページ番号を返す

**具体例:** `totalPages=3` の状態で `allocatePage()` を呼ぶと:
- ページ番号 3 が返る
- `totalPages` は 4 になる
- ファイルのオフセット `3 * 4096 = 12288` にゼロ埋めページが書かれる

#### flushHeader() -- ヘッダーページの書き戻し

```typescript
// src/storage/pager.ts:189-193
private flushHeader(): void {
    const headerPage = Buffer.alloc(this.pageSize, 0);
    writeFileHeader(headerPage, this.header);
    this.writePageRaw(0, headerPage);
  }
```

ページサイズ分のバッファを確保し、`writeFileHeader()` で 14 バイトのヘッダーを書き込み、ページ0に上書きします。ヘッダー以降のバイト (14 ~ 4095) はゼロ埋めです。

---

### 4-1-4 バイナリI/O詳細

> **この節で理解できること:** Node.js の `fs` モジュールと `Buffer` を使った低レベルI/Oの実装方法。

#### Node.js fs の利用

Pager は以下の `fs` 関数を直接利用しています。

```typescript
// src/storage/pager.ts:1-2
import { openSync, closeSync, readSync, writeSync, fstatSync, type BunFile } from "fs";
import { existsSync } from "node:fs";
```

| 関数 | 用途 |
|---|---|
| `openSync(path, mode)` | ファイルディスクリプタの取得。新規作成時は `"w+"`、既存オープン時は `"r+"` |
| `readSync(fd, buf, offset, length, position)` | 指定位置からの同期読み込み |
| `writeSync(fd, buf, offset, length, position)` | 指定位置への同期書き込み |
| `closeSync(fd)` | ファイルディスクリプタの解放 |
| `existsSync(path)` | ファイル存在確認 (新規 or 既存の判定に使用) |

#### writePageRaw -- 最下層の書き込み

```typescript
// src/storage/pager.ts:184-187
private writePageRaw(pageNum: number, data: Buffer): void {
    const offset = pageNum * this.pageSize;
    writeSync(this.fd, data, 0, this.pageSize, offset);
  }
```

バリデーションなしの生書き込みです。`writePage()` や `flushHeader()` から呼ばれます。

#### Buffer でのリトルエンディアン読み書き

ヘッダーの読み書きヘルパーは `Buffer` の LE (リトルエンディアン) メソッドを使っています。

```typescript
// src/storage/pager.ts:200-205
function writeFileHeader(buf: Buffer, header: FileHeader): void {
  buf.writeUInt32LE(header.magic, HEADER_MAGIC_OFFSET);
  buf.writeUInt16LE(header.pageSize, HEADER_PAGE_SIZE_OFFSET);
  buf.writeUInt32LE(header.totalPages, HEADER_TOTAL_PAGES_OFFSET);
  buf.writeUInt32LE(header.schemaPage, HEADER_SCHEMA_PAGE_OFFSET);
}
```

```typescript
// src/storage/pager.ts:207-222
function readFileHeader(buf: Buffer): PagerResult<FileHeader> {
  const magic = buf.readUInt32LE(HEADER_MAGIC_OFFSET);
  if (magic !== MAGIC_NUMBER) {
    return { success: false, error: `Invalid magic number: 0x${magic.toString(16)} (expected 0x${MAGIC_NUMBER.toString(16)})` };
  }

  return {
    success: true,
    data: {
      magic,
      pageSize: buf.readUInt16LE(HEADER_PAGE_SIZE_OFFSET),
      totalPages: buf.readUInt32LE(HEADER_TOTAL_PAGES_OFFSET),
      schemaPage: buf.readUInt32LE(HEADER_SCHEMA_PAGE_OFFSET),
    },
  };
}
```

`readFileHeader()` はマジックナンバーの検証を行い、不一致の場合はエラーを返します。これにより、SQLite 形式でないファイルを誤って開くことを防ぎます。

---

## 4-2 B+Tree (`btree.ts`)

### 4-2-1 型定義とページレイアウト

> **この節で理解できること:** B+Tree のレコード型とノードのバイナリ構造。

#### ColumnValue / BTreeRecord / BTreeResult

```typescript
// src/db/btree.ts:8-19
/** レコードの1カラム分の値 */
export type ColumnValue = number | string | null;

/** 1レコード = キー + カラム値の配列 */
export type BTreeRecord = {
  key: number;
  values: ColumnValue[];
};

export type BTreeResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };
```

- `ColumnValue`: 1つのカラム値。INTEGER (`number`)、TEXT (`string`)、NULL (`null`) の3種類。
- `BTreeRecord`: B+Tree が格納する1レコード。整数キーと値配列のペア。
- `BTreeResult<T>`: Pager と同じ Result 型パターン。

#### SplitResult -- 分割情報

```typescript
// src/db/btree.ts:22-24
/** 分割が発生した場合の昇格情報 */
type SplitResult =
  | { split: false }
  | { split: true; promotedKey: number; newPageNum: number };
```

ノード分割が発生したかどうかと、発生した場合の昇格キー・新ページ番号を表します。

#### リーフノードのバイナリレイアウト

```
// src/db/btree.ts:29-33
// リーフノード:
//   [0]      u8   ページタイプ (0x02)
//   [1..2]   u16  セル数
//   [3..6]   u32  右兄弟ページ番号 (0 = なし)
//   [7..]    セルの配列 (各セルは可変長)
```

| オフセット | サイズ | 型 | フィールド | 説明 |
|---|---|---|---|---|
| 0 | 1 | u8 | pageType | `0x02` (LeafNode) |
| 1 | 2 | u16 | cellCount | セル (レコード) の個数 |
| 3 | 4 | u32 | rightSibling | 右兄弟リーフのページ番号 (0=末端) |
| 7 | 可変 | - | cells[] | セルの配列 (後述のセル形式) |

ヘッダー部分は 7 バイト固定 (`NODE_HEADER_SIZE = 7`) です。

#### 内部ノードのバイナリレイアウト

```
// src/db/btree.ts:35-39
// 内部ノード:
//   [0]      u8   ページタイプ (0x03)
//   [1..2]   u16  キー数
//   [3..6]   u32  最左子ページ番号
//   [7..]    (キー u32 + 子ページ番号 u32) ペアの配列
```

| オフセット | サイズ | 型 | フィールド | 説明 |
|---|---|---|---|---|
| 0 | 1 | u8 | pageType | `0x03` (InternalNode) |
| 1 | 2 | u16 | keyCount | キーの個数 |
| 3 | 4 | u32 | leftmostChild | 最左子ページの番号 |
| 7 | 8*N | u32+u32 | entries[] | (キー, 子ページ番号) のペア配列 |

各エントリは 8 バイト固定 (`INTERNAL_ENTRY_SIZE = 8`) です。

```typescript
// src/db/btree.ts:42-43
const NODE_HEADER_SIZE = 7;
const INTERNAL_ENTRY_SIZE = 8; // キー(4) + 子ページ番号(4)
```

**具体例:** キーが [5, 10] で最左子=ページ2、子=[ページ3, ページ4] の内部ノード

```
オフセット  値              説明
0x00        03              pageType = InternalNode
0x01        02 00           keyCount = 2
0x03        02 00 00 00     leftmostChild = ページ2
0x07        05 00 00 00     key[0] = 5
0x0B        03 00 00 00     child[0] = ページ3
0x0F        0A 00 00 00     key[1] = 10
0x13        04 00 00 00     child[1] = ページ4
```

ルーティングルール: `key < 5` ならページ2、`5 <= key < 10` ならページ3、`key >= 10` ならページ4。

---

### 4-2-2 生成と復元

> **この節で理解できること:** B+Tree の新規作成時と既存ツリーの復元時の初期化方法。

#### create() -- 新しい空の B+Tree を作成

```typescript
// src/db/btree.ts:67-83
static create(pager: Pager): BTreeResult<BTree> {
    const allocResult = pager.allocatePage();
    if (!allocResult.success) return allocResult;

    const rootPageNum = allocResult.data;

    // 空のリーフノードとして初期化
    const page = Buffer.alloc(pager.getPageSize(), 0);
    page.writeUInt8(PAGE_TYPE.LEAF_NODE, 0);
    page.writeUInt16LE(0, 1);
    page.writeUInt32LE(0, 3);

    const writeResult = pager.writePage(rootPageNum, page);
    if (!writeResult.success) return writeResult;

    return { success: true, data: new BTree(pager, rootPageNum) };
  }
```

**フロー:**

1. `pager.allocatePage()` でルート用のページを割り当て
2. ページをリーフノードとして初期化 (セル数=0、右兄弟=0)
3. ディスクに書き込み
4. `BTree` インスタンスを返す

初期状態のルートは空のリーフノードです。INSERT されると、このリーフにセルが追加されていきます。

#### open() -- 既存の B+Tree をルートページ番号から復元

```typescript
// src/db/btree.ts:88-90
static open(pager: Pager, rootPageNum: number): BTree {
    return new BTree(pager, rootPageNum);
  }
```

既存のツリーはルートページ番号さえわかればそこからツリー構造を辿れるため、コンストラクタにルートページ番号を渡すだけです。ページデータはアクセス時に Pager を通じてオンデマンドで読み込みます。

#### コンストラクタの学習用設定

```typescript
// src/db/btree.ts:55-62
constructor(pager: Pager, rootPageNum: number) {
    this.pager = pager;
    this.rootPageNum = rootPageNum;

    // 学習目的で小さめにして分割を観察しやすくする
    this.maxLeafCells = 4;
    this.maxInternalKeys = 4;
  }
```

`maxLeafCells = 4` はリーフノードに最大4レコードまで格納できることを意味します。5件目を挿入するとリーフ分割が発生します。本番の SQLite ではページサイズとレコードサイズから動的に計算されますが、本実装では学習目的で小さな固定値にしています。

---

### 4-2-3 シリアライズ/デシリアライズ

> **この節で理解できること:** レコードがバイナリとしてどう格納・復元されるか。

#### セル形式

```
// src/db/btree.ts:461-468
// セル形式:
//   [key]        u32 (4 bytes)
//   [valueCount] u16 (2 bytes)
//   [values...]  各値:
//     型タグ u8: 0x00=NULL, 0x01=INTEGER, 0x02=TEXT
//     INTEGER: i32 (4 bytes, LE)
//     TEXT:    u16 長さ + N bytes UTF-8
```

1つのセル (= 1レコード) は以下の構造で可変長です。

| 部位 | サイズ | 説明 |
|---|---|---|
| key | 4 | u32 レコードキー |
| valueCount | 2 | u16 カラム値の個数 |
| 各 value | 可変 | 型タグ (1バイト) + 型に応じたペイロード |

#### 型タグ

| タグ | 型 | ペイロード |
|---|---|---|
| `0x00` | NULL | なし (0バイト) |
| `0x01` | INTEGER | i32 (4バイト、リトルエンディアン) |
| `0x02` | TEXT | u16 長さ (2バイト) + UTF-8 文字列 (可変長) |

**具体例:** `{ key: 1, values: [42, "hello"] }` のバイナリ表現

```
01 00 00 00       key = 1
02 00              valueCount = 2
01                 型タグ = INTEGER
2A 00 00 00       value = 42
02                 型タグ = TEXT
05 00              文字列長 = 5
68 65 6C 6C 6F    "hello" (UTF-8)
```

合計: 4 + 2 + (1+4) + (1+2+5) = 19 バイト

#### readLeafCells() の実装

```typescript
// src/db/btree.ts:470-503
private readLeafCells(page: Buffer, cellCount: number): BTreeRecord[] {
    const cells: BTreeRecord[] = [];
    let offset = NODE_HEADER_SIZE;

    for (let i = 0; i < cellCount; i++) {
      const key = page.readUInt32LE(offset);
      offset += 4;

      const valueCount = page.readUInt16LE(offset);
      offset += 2;

      const values: ColumnValue[] = [];
      for (let j = 0; j < valueCount; j++) {
        const typeTag = page.readUInt8(offset);
        offset += 1;

        if (typeTag === 0x00) {
          values.push(null);
        } else if (typeTag === 0x01) {
          values.push(page.readInt32LE(offset));
          offset += 4;
        } else if (typeTag === 0x02) {
          const strLen = page.readUInt16LE(offset);
          offset += 2;
          values.push(page.toString("utf-8", offset, offset + strLen));
          offset += strLen;
        }
      }

      cells.push({ key, values });
    }

    return cells;
  }
```

ヘッダー直後 (オフセット 7) からセルを順番に読みます。型タグに応じてオフセットの進み方が変わるため、先頭から順番にパースする必要があります (ランダムアクセスはできません)。

#### writeLeafCellsToBuffer() の実装

```typescript
// src/db/btree.ts:505-537
private writeLeafCellsToBuffer(page: Buffer, cells: BTreeRecord[]): void {
    page.writeUInt16LE(cells.length, 1);

    let offset = NODE_HEADER_SIZE;

    for (const cell of cells) {
      page.writeUInt32LE(cell.key, offset);
      offset += 4;

      page.writeUInt16LE(cell.values.length, offset);
      offset += 2;

      for (const value of cell.values) {
        if (value === null) {
          page.writeUInt8(0x00, offset);
          offset += 1;
        } else if (typeof value === "number") {
          page.writeUInt8(0x01, offset);
          offset += 1;
          page.writeInt32LE(value, offset);
          offset += 4;
        } else {
          page.writeUInt8(0x02, offset);
          offset += 1;
          const strBuf = Buffer.from(value, "utf-8");
          page.writeUInt16LE(strBuf.length, offset);
          offset += 2;
          strBuf.copy(page, offset);
          offset += strBuf.length;
        }
      }
    }
  }
```

`readLeafCells()` の逆操作です。まずヘッダーのセル数フィールドを更新し、オフセット 7 から各セルを書き込みます。TEXT 値は `Buffer.from(value, "utf-8")` で UTF-8 エンコードし、バイト長を u16 で先行して書き込みます。

---

### 4-2-4 INSERT -- パス追跡方式

> **この節で理解できること:** レコード挿入、リーフ分割、昇格キーの親方向伝播の全体フロー。

#### insert() の全体フロー

```typescript
// src/db/btree.ts:106-155
insert(record: BTreeRecord): BTreeResult<void> {
    // ルートからリーフまでのパスを記録
    const path: number[] = [];
    const findResult = this.findLeafPage(this.rootPageNum, record.key, path);
    if (!findResult.success) return findResult;

    const leafPageNum = findResult.data;

    // リーフにレコードを挿入
    const readResult = this.pager.readPage(leafPageNum);
    if (!readResult.success) return readResult;

    const page = readResult.data;
    const cellCount = page.readUInt16LE(1);
    const cells = this.readLeafCells(page, cellCount);

    // 重複キーチェック
    for (const cell of cells) {
      if (cell.key === record.key) {
        return { success: false, error: `Duplicate key: ${record.key}` };
      }
    }

    // ソート済みの位置に挿入
    let insertPos = 0;
    while (insertPos < cells.length && cells[insertPos].key < record.key) {
      insertPos++;
    }
    cells.splice(insertPos, 0, record);

    // ページに書き戻す
    const newPage = Buffer.alloc(this.pager.getPageSize(), 0);
    newPage.writeUInt8(PAGE_TYPE.LEAF_NODE, 0);
    newPage.writeUInt32LE(page.readUInt32LE(3), 3); // 右兄弟を維持
    this.writeLeafCellsToBuffer(newPage, cells);
    const writeResult = this.pager.writePage(leafPageNum, newPage);
    if (!writeResult.success) return writeResult;

    // 分割が必要か
    if (cells.length <= this.maxLeafCells) {
      return { success: true, data: undefined };
    }

    // リーフを分割
    const splitResult = this.splitLeafNode(leafPageNum, cells);
    if (!splitResult.success) return splitResult;

    // 昇格キーを親に伝播
    return this.propagateSplit(path, splitResult.data.promotedKey, splitResult.data.newPageNum);
  }
```

**全体の流れ (5ステップ):**

1. **パス記録:** `findLeafPage()` でルートからリーフまで降下し、経路上の内部ノードを `path[]` に記録
2. **リーフ読み込み + 重複チェック:** 対象リーフページを読み、既に同じキーが存在しないか確認
3. **ソート済み挿入:** キー順を維持しながら `cells[]` にレコードを挿入
4. **ページ書き戻し:** 挿入後のセル配列をバイナリ化してページに書き込み
5. **分割判定:** セル数が `maxLeafCells` を超えていれば分割 + 昇格キーの親方向伝播

#### findLeafPage() -- ルートからリーフまでのpath記録

```typescript
// src/db/btree.ts:160-174
private findLeafPage(pageNum: number, key: number, path: number[]): BTreeResult<number> {
    const readResult = this.pager.readPage(pageNum);
    if (!readResult.success) return readResult;

    const pageType = readResult.data.readUInt8(0) as PageType;

    if (pageType === PAGE_TYPE.LEAF_NODE) {
      return { success: true, data: pageNum };
    }

    // 内部ノード: パスに記録して子に降りる
    path.push(pageNum);
    const childPageNum = this.findChildPage(readResult.data, key);
    return this.findLeafPage(childPageNum, key, path);
  }
```

再帰的にツリーを降下します。内部ノードに到達するたびにそのページ番号を `path[]` に追加し、`findChildPage()` で適切な子ページを選んで降下を続けます。リーフに到達したらそのページ番号を返します。

**具体例:** ルート=ページ5 (内部ノード、キー[10]) で key=7 を挿入する場合

```
path 記録の流れ:
  ページ5 (内部ノード)  → path=[5]、key=7 < 10 なので左子(ページ3)へ
  ページ3 (リーフ)      → リーフなので return 3

結果: path=[5], リーフページ=3
```

#### ソート済み挿入と重複キーチェック

挿入前にリーフ内の全セルをスキャンして重複キーを検出します。

```typescript
// src/db/btree.ts:123-134
// 重複キーチェック
for (const cell of cells) {
  if (cell.key === record.key) {
    return { success: false, error: `Duplicate key: ${record.key}` };
  }
}

// ソート済みの位置に挿入
let insertPos = 0;
while (insertPos < cells.length && cells[insertPos].key < record.key) {
  insertPos++;
}
cells.splice(insertPos, 0, record);
```

セル配列はキー順にソートされているため、線形スキャンで正しい挿入位置を見つけ、`splice()` で配列に挿入します。

#### splitLeafNode() -- リーフ分割

```typescript
// src/db/btree.ts:179-214
private splitLeafNode(
    pageNum: number,
    cells: BTreeRecord[],
  ): BTreeResult<{ promotedKey: number; newPageNum: number }> {
    // 元ページの右兄弟を取得
    const readResult = this.pager.readPage(pageNum);
    if (!readResult.success) return readResult;
    const oldSiblingPageNum = readResult.data.readUInt32LE(3);

    const splitPoint = Math.ceil(cells.length / 2);
    const leftCells = cells.slice(0, splitPoint);
    const rightCells = cells.slice(splitPoint);
    const promotedKey = rightCells[0].key;

    // 新しいリーフ(右)を作成
    const allocResult = this.pager.allocatePage();
    if (!allocResult.success) return allocResult;
    const newPageNum = allocResult.data;

    const rightPage = Buffer.alloc(this.pager.getPageSize(), 0);
    rightPage.writeUInt8(PAGE_TYPE.LEAF_NODE, 0);
    rightPage.writeUInt32LE(oldSiblingPageNum, 3); // 元の右兄弟を引き継ぐ
    this.writeLeafCellsToBuffer(rightPage, rightCells);
    const wr1 = this.pager.writePage(newPageNum, rightPage);
    if (!wr1.success) return wr1;

    // 左ノード(元ページ)を更新
    const leftPage = Buffer.alloc(this.pager.getPageSize(), 0);
    leftPage.writeUInt8(PAGE_TYPE.LEAF_NODE, 0);
    leftPage.writeUInt32LE(newPageNum, 3); // 右兄弟 = 新ページ
    this.writeLeafCellsToBuffer(leftPage, leftCells);
    const wr2 = this.pager.writePage(pageNum, leftPage);
    if (!wr2.success) return wr2;

    return { success: true, data: { promotedKey, newPageNum } };
  }
```

**分割のフロー:**

1. 分割点を `Math.ceil(cells.length / 2)` で計算 (5セルなら splitPoint=3)
2. 前半を左ノード (元ページ)、後半を右ノード (新ページ) に分ける
3. 昇格キーは右ノードの先頭キー (`rightCells[0].key`)
4. 右兄弟ポインタを付け替える:
   - 新右ノードの右兄弟 = 元の右兄弟 (リンクリストの連結を維持)
   - 左ノードの右兄弟 = 新右ノード

**具体例: 5件INSERT時のリーフ分割**

`maxLeafCells = 4` の設定で、キー 1, 2, 3, 4, 5 を順に INSERT した場合:

```
---- INSERT 1~4: リーフが1つで収まる ----

  [ルート/リーフ ページ2]
  cells: [1, 2, 3, 4]
  rightSibling: 0 (なし)

---- INSERT 5: セル数が5になり maxLeafCells=4 を超える → 分割 ----

  分割前: cells = [1, 2, 3, 4, 5]
  splitPoint = Math.ceil(5/2) = 3
  leftCells  = [1, 2, 3]
  rightCells = [4, 5]
  promotedKey = 4

  分割後:

        [新ルート ページ4 (内部ノード)]
         leftmostChild=2, entries=[(key=4, child=3)]
        /                   \
  [ページ2 (リーフ)]     [ページ3 (リーフ)]
  cells: [1, 2, 3]       cells: [4, 5]
  rightSibling: 3         rightSibling: 0

  ページ2 → ページ3 のリンクリストが形成される
```

#### propagateSplit() -- 昇格キーの親方向伝播

```typescript
// src/db/btree.ts:219-261
private propagateSplit(
    path: number[],
    promotedKey: number,
    newChildPageNum: number,
  ): BTreeResult<void> {
    if (path.length === 0) {
      // パスが空 = ルートリーフが分割された → 新しいルートを作る
      return this.createNewRoot(this.rootPageNum, promotedKey, newChildPageNum);
    }

    // 親ノードにキーを挿入
    const parentPageNum = path.pop()!;
    const readResult = this.pager.readPage(parentPageNum);
    if (!readResult.success) return readResult;

    const page = readResult.data;
    const entries = this.readInternalEntries(page);

    // ソート済みの位置に挿入
    let insertPos = 0;
    while (insertPos < entries.length && entries[insertPos].key < promotedKey) {
      insertPos++;
    }
    entries.splice(insertPos, 0, { key: promotedKey, childPageNum: newChildPageNum });

    // 書き戻す
    const leftmostChild = page.readUInt32LE(3);
    this.writeInternalNode(page, leftmostChild, entries);
    const writeResult = this.pager.writePage(parentPageNum, page);
    if (!writeResult.success) return writeResult;

    // 親がオーバーフローしていなければ完了
    if (entries.length <= this.maxInternalKeys) {
      return { success: true, data: undefined };
    }

    // 内部ノードを分割
    const splitResult = this.splitInternalNode(parentPageNum);
    if (!splitResult.success) return splitResult;

    return this.propagateSplit(path, splitResult.data.promotedKey, splitResult.data.newPageNum);
  }
```

**フロー:**

1. `path` が空なら、ルートリーフが分割されたケース → `createNewRoot()` で新ルートを作成
2. `path` の末尾 (直近の親) を取り出し、昇格キーを内部ノードに挿入
3. 内部ノードのエントリ数が `maxInternalKeys` 以下なら終了
4. 超えていれば `splitInternalNode()` で内部ノードを分割し、再帰的に `propagateSplit()` を呼ぶ

#### splitInternalNode() -- 内部ノード分割

```typescript
// src/db/btree.ts:266-302
private splitInternalNode(
    pageNum: number,
  ): BTreeResult<{ promotedKey: number; newPageNum: number }> {
    const readResult = this.pager.readPage(pageNum);
    if (!readResult.success) return readResult;

    const page = readResult.data;
    const leftmostChild = page.readUInt32LE(3);
    const entries = this.readInternalEntries(page);

    const splitPoint = Math.floor(entries.length / 2);
    const promotedKey = entries[splitPoint].key;

    const leftEntries = entries.slice(0, splitPoint);
    const rightEntries = entries.slice(splitPoint + 1);
    // 右ノードの最左子 = 昇格キーの右子
    const rightLeftmostChild = entries[splitPoint].childPageNum;

    // 新しい内部ノード(右)を作成
    const allocResult = this.pager.allocatePage();
    if (!allocResult.success) return allocResult;
    const newPageNum = allocResult.data;

    const rightPage = Buffer.alloc(this.pager.getPageSize(), 0);
    this.writeInternalNode(rightPage, rightLeftmostChild, rightEntries);
    const wr1 = this.pager.writePage(newPageNum, rightPage);
    if (!wr1.success) return wr1;

    // 左ノード(元ページ)を更新
    const leftPage = Buffer.alloc(this.pager.getPageSize(), 0);
    this.writeInternalNode(leftPage, leftmostChild, leftEntries);
    const wr2 = this.pager.writePage(pageNum, leftPage);
    if (!wr2.success) return wr2;

    return { success: true, data: { promotedKey, newPageNum } };
  }
```

内部ノードの分割はリーフとは少し異なります。

**リーフ分割との違い:**
- 分割点のエントリのキーが「昇格キー」として親に上げられる (リーフではコピー、内部ノードでは移動)
- 分割点のエントリの `childPageNum` は右ノードの `leftmostChild` になる
- 右兄弟ポインタの管理は不要 (内部ノードにはリンクリストがない)

**具体例:** エントリ [3, 5, 7, 9, 11] (5つ) の内部ノード分割

```
splitPoint = Math.floor(5/2) = 2
promotedKey = 7

left entries:  [3, 5]         (splitPoint より前)
right entries: [9, 11]        (splitPoint+1 以降)
rightLeftmostChild = entries[2].childPageNum  (キー7の右子)
```

#### createNewRoot() -- 新ルート作成

```typescript
// src/db/btree.ts:307-324
private createNewRoot(
    leftPageNum: number,
    key: number,
    rightPageNum: number,
  ): BTreeResult<void> {
    const allocResult = this.pager.allocatePage();
    if (!allocResult.success) return allocResult;
    const newRootPageNum = allocResult.data;

    const page = Buffer.alloc(this.pager.getPageSize(), 0);
    this.writeInternalNode(page, leftPageNum, [{ key, childPageNum: rightPageNum }]);

    const writeResult = this.pager.writePage(newRootPageNum, page);
    if (!writeResult.success) return writeResult;

    this.rootPageNum = newRootPageNum;
    return { success: true, data: undefined };
  }
```

ルートの分割時に呼ばれます。新しいページを割り当て、内部ノードとして初期化します。

- `leftmostChild` = 元のルートページ (左)
- エントリ = `[{ key: 昇格キー, childPageNum: 右ページ }]`

最後に `this.rootPageNum` を新ルートに更新します。この更新はメモリ上のみで、Database 側がスキーマページに永続化する責務を持ちます。

---

### 4-2-5 SEARCH

> **この節で理解できること:** キーによる1件検索の再帰的な探索フロー。

#### search() -- searchInNode() の再帰

```typescript
// src/db/btree.ts:330-354
search(key: number): BTreeResult<BTreeRecord | null> {
    return this.searchInNode(this.rootPageNum, key);
  }

  private searchInNode(pageNum: number, key: number): BTreeResult<BTreeRecord | null> {
    const readResult = this.pager.readPage(pageNum);
    if (!readResult.success) return readResult;

    const page = readResult.data;
    const pageType = page.readUInt8(0) as PageType;

    if (pageType === PAGE_TYPE.LEAF_NODE) {
      const cellCount = page.readUInt16LE(1);
      const cells = this.readLeafCells(page, cellCount);
      for (const cell of cells) {
        if (cell.key === key) {
          return { success: true, data: cell };
        }
      }
      return { success: true, data: null };
    }

    const childPageNum = this.findChildPage(page, key);
    return this.searchInNode(childPageNum, key);
  }
```

**フロー:**

1. ルートページから開始
2. 内部ノードなら `findChildPage()` で適切な子を選び再帰
3. リーフノードに到達したらセルを線形スキャンしてキー一致を探す
4. 見つかればレコードを返し、見つからなければ `null` を返す

#### findChildPage() -- 内部ノードでのキー比較ロジック

```typescript
// src/db/btree.ts:403-419
private findChildPage(page: Buffer, key: number): number {
    const keyCount = page.readUInt16LE(1);
    const leftmostChild = page.readUInt32LE(3);

    for (let i = 0; i < keyCount; i++) {
      const offset = NODE_HEADER_SIZE + i * INTERNAL_ENTRY_SIZE;
      const nodeKey = page.readUInt32LE(offset);

      if (key < nodeKey) {
        if (i === 0) return leftmostChild;
        return page.readUInt32LE(NODE_HEADER_SIZE + (i - 1) * INTERNAL_ENTRY_SIZE + 4);
      }
    }

    // 全てのキー以上 → 最後の子ページ
    return page.readUInt32LE(NODE_HEADER_SIZE + (keyCount - 1) * INTERNAL_ENTRY_SIZE + 4);
  }
```

**ルーティングのルール:**

エントリ列が `[(k0, c0), (k1, c1), ..., (kN-1, cN-1)]` のとき:

| 条件 | 選ばれる子ページ |
|---|---|
| `key < k0` | `leftmostChild` |
| `k(i-1) <= key < k(i)` | `c(i-1)` (直前のエントリの子) |
| `key >= k(N-1)` | `c(N-1)` (最後のエントリの子) |

**具体例:** 内部ノードに `leftmostChild=2`, エントリ `[(5, 3), (10, 4)]` がある場合

- `key=3`: `3 < 5` → `leftmostChild` = ページ2
- `key=7`: `7 >= 5` かつ `7 < 10` → `c0` = ページ3
- `key=15`: `15 >= 10` → `c1` = ページ4

---

### 4-2-6 SCAN -- リンクリスト走査

> **この節で理解できること:** B+Tree の全レコードをキー順に取得するフロー。

#### scan() の全体フロー

```typescript
// src/db/btree.ts:360-382
scan(): BTreeResult<BTreeRecord[]> {
    const records: BTreeRecord[] = [];

    const leftmostResult = this.findLeftmostLeaf(this.rootPageNum);
    if (!leftmostResult.success) return leftmostResult;

    let currentPageNum: number | null = leftmostResult.data;

    while (currentPageNum !== null && currentPageNum !== 0) {
      const readResult = this.pager.readPage(currentPageNum);
      if (!readResult.success) return readResult;

      const page = readResult.data;
      const cellCount = page.readUInt16LE(1);
      const cells = this.readLeafCells(page, cellCount);
      records.push(...cells);

      const nextPageNum = page.readUInt32LE(3);
      currentPageNum = nextPageNum === 0 ? null : nextPageNum;
    }

    return { success: true, data: records };
  }
```

**フロー (2段階):**

1. `findLeftmostLeaf()` で最左リーフに到達
2. 右兄弟ポインタ (オフセット3のu32) を辿るループで全リーフをスキャン

各リーフのセルをすべて読み取り、`records[]` に追加していきます。右兄弟ポインタが 0 になったらリンクリストの末端に到達したことを意味するので、ループを終了します。

#### findLeftmostLeaf() -- 最左リーフへの降下

```typescript
// src/db/btree.ts:384-397
private findLeftmostLeaf(pageNum: number): BTreeResult<number> {
    const readResult = this.pager.readPage(pageNum);
    if (!readResult.success) return readResult;

    const page = readResult.data;
    const pageType = page.readUInt8(0) as PageType;

    if (pageType === PAGE_TYPE.LEAF_NODE) {
      return { success: true, data: pageNum };
    }

    const leftChildPageNum = page.readUInt32LE(3);
    return this.findLeftmostLeaf(leftChildPageNum);
  }
```

常に `leftmostChild` (オフセット3のu32) を辿って最も左のリーフまで降下します。内部ノードの場合は左端の子へ再帰し、リーフに到達したらそのページ番号を返します。

**具体例:** 分割後のツリーでの scan() の動き

```
        [ルート ページ4 (内部ノード)]
         leftmostChild=2
        /                \
  [ページ2 (リーフ)]    [ページ3 (リーフ)]
  cells: [1, 2, 3]      cells: [4, 5]
  rightSibling: 3        rightSibling: 0

1. findLeftmostLeaf(4):
   ページ4 は内部ノード → leftmostChild=2 へ再帰
   ページ2 はリーフ → return 2

2. ループ:
   currentPageNum=2 → cells [1,2,3] を追加、rightSibling=3
   currentPageNum=3 → cells [4,5] を追加、rightSibling=0 → ループ終了

結果: records = [{key:1,...}, {key:2,...}, {key:3,...}, {key:4,...}, {key:5,...}]
```

---

## 4-3 Database -- 統合エンジン (`database.ts`)

### 4-3-1 型定義

> **この節で理解できること:** Database が扱うデータの型と、SQL 実行結果の構造。

```typescript
// src/db/database.ts:16-29
export type Record = {
  [columnName: string]: ColumnValue;
};

export type QueryResult =
  | { success: true; message: string; columns?: string[]; records?: Record[] }
  | { success: false; error: string };

/** スキーマ上のテーブル情報 */
type TableSchema = {
  name: string;
  columns: ColumnDef[];
  rootPageNum: number;
};
```

| 型 | 説明 |
|---|---|
| `Record` | カラム名をキー、`ColumnValue` を値とするオブジェクト。SELECT の結果1行に対応。 |
| `QueryResult` | SQL 実行結果。成功時はメッセージとオプションのカラム名/レコード配列、失敗時はエラーメッセージ。 |
| `TableSchema` | テーブルのメタ情報。テーブル名、カラム定義配列、B+Tree のルートページ番号を保持。 |

---

### 4-3-2 構造と初期化

> **この節で理解できること:** Database の起動処理とメモリキャッシュの仕組み。

#### open() -- Pager.open() + loadSchema()

```typescript
// src/db/database.ts:72-88
static open(filePath: string): QueryResult & { db?: Database } {
    const pagerResult = Pager.open(filePath);
    if (!pagerResult.success) {
      return { success: false, error: pagerResult.error };
    }

    const db = new Database(pagerResult.data);

    // スキーマページからテーブル情報を読み込む
    const loadResult = db.loadSchema();
    if (!loadResult.success) {
      pagerResult.data.close();
      return loadResult;
    }

    return { success: true, message: "Database opened", db };
  }
```

**フロー:**

1. `Pager.open()` でファイルを開く (新規作成 or 既存オープン)
2. `Database` インスタンスを生成
3. `loadSchema()` でスキーマページからテーブル情報をメモリに読み込み
4. 失敗時は Pager をクローズしてエラーを返す

#### tables と btrees のメモリキャッシュ

```typescript
// src/db/database.ts:60-63
export class Database {
  private pager: Pager;
  private tables: Map<string, TableSchema> = new Map();
  private btrees: Map<string, BTree> = new Map();
```

| フィールド | 型 | 用途 |
|---|---|---|
| `tables` | `Map<string, TableSchema>` | テーブル名 (小文字化) → スキーマ情報のマッピング |
| `btrees` | `Map<string, BTree>` | テーブル名 (小文字化) → BTree インスタンスのマッピング |

キーはすべて小文字化されており、テーブル名の大文字小文字を区別しません。`loadSchema()` 時にディスクからメモリにロードされ、`executeCreate()` 時にエントリが追加されます。

---

### 4-3-3 スキーマページのシリアライズ

> **この節で理解できること:** テーブル定義がスキーマページにどうバイナリ化されるか。

#### スキーマページのバイナリレイアウト

```
// src/db/database.ts:32-44
// [0]      u8   ページタイプ (0x01 = Schema)
// [1..2]   u16  テーブル数
// [3..]    テーブルエントリの配列:
//   - テーブル名: u16(長さ) + UTF-8
//   - カラム数: u16
//   - カラム定義の配列:
//     - カラム名: u16(長さ) + UTF-8
//     - 型: u8 (0x01=INTEGER, 0x02=TEXT)
//     - 制約フラグ: u8 (bit0=PRIMARY_KEY, bit1=NOT_NULL, bit2=UNIQUE)
//   - ルートページ番号: u32
```

| オフセット | サイズ | 型 | フィールド | 説明 |
|---|---|---|---|---|
| 0 | 1 | u8 | pageType | `0x01` (Schema) |
| 1 | 2 | u16 | tableCount | テーブルの個数 |
| 3 | 可変 | - | entries[] | テーブルエントリの配列 |

各テーブルエントリの構造:

| 部位 | サイズ | 型 | 説明 |
|---|---|---|---|
| テーブル名長 | 2 | u16 | テーブル名のバイト長 |
| テーブル名 | 可変 | UTF-8 | テーブル名文字列 |
| カラム数 | 2 | u16 | カラムの個数 |
| カラム定義 | 可変 | - | カラム数分繰り返し (下記参照) |
| ルートページ番号 | 4 | u32 | B+Tree のルートページ |

各カラム定義の構造:

| 部位 | サイズ | 型 | 説明 |
|---|---|---|---|
| カラム名長 | 2 | u16 | カラム名のバイト長 |
| カラム名 | 可変 | UTF-8 | カラム名文字列 |
| 型タグ | 1 | u8 | `0x01`=INTEGER, `0x02`=TEXT |
| 制約フラグ | 1 | u8 | ビットフィールド (下記参照) |

#### COLUMN_TYPE_MAP / COLUMN_TYPE_REVERSE

```typescript
// src/db/database.ts:46-54
const COLUMN_TYPE_MAP: { [key: string]: number } = {
  INTEGER: 0x01,
  TEXT: 0x02,
};

const COLUMN_TYPE_REVERSE: { [key: number]: "INTEGER" | "TEXT" } = {
  0x01: "INTEGER",
  0x02: "TEXT",
};
```

SQL の型名とバイナリタグを双方向に変換するためのマッピングです。

#### 制約フラグのビットフィールド

1バイトのビットフィールドで制約を表現します。

| ビット | マスク | 制約 |
|---|---|---|
| bit 0 | `0x01` | PRIMARY_KEY |
| bit 1 | `0x02` | NOT_NULL |
| bit 2 | `0x04` | UNIQUE |

```typescript
// src/db/database.ts:435-439 (saveSchema内)
let flags = 0;
if (col.constraints.includes("PRIMARY_KEY")) flags |= 0x01;
if (col.constraints.includes("NOT_NULL")) flags |= 0x02;
if (col.constraints.includes("UNIQUE")) flags |= 0x04;
```

**具体例:** `id INTEGER PRIMARY KEY NOT NULL` のカラムは `flags = 0x01 | 0x02 = 0x03` になります。

#### loadSchema() -- スキーマの読み込み

```typescript
// src/db/database.ts:343-399
private loadSchema(): QueryResult {
    const header = this.pager.getHeader();
    const readResult = this.pager.readPage(header.schemaPage);
    if (!readResult.success) {
      return { success: false, error: readResult.error };
    }

    const page = readResult.data;
    const tableCount = page.readUInt16LE(1);
    let offset = 3;

    for (let i = 0; i < tableCount; i++) {
      // テーブル名
      const nameLen = page.readUInt16LE(offset);
      offset += 2;
      const name = page.toString("utf-8", offset, offset + nameLen);
      offset += nameLen;

      // カラム数
      const colCount = page.readUInt16LE(offset);
      offset += 2;

      const columns: ColumnDef[] = [];
      for (let j = 0; j < colCount; j++) {
        // カラム名
        const colNameLen = page.readUInt16LE(offset);
        offset += 2;
        const colName = page.toString("utf-8", offset, offset + colNameLen);
        offset += colNameLen;

        // 型
        const typeTag = page.readUInt8(offset);
        offset += 1;
        const colType = COLUMN_TYPE_REVERSE[typeTag] ?? "TEXT";

        // 制約フラグ
        const constraintFlags = page.readUInt8(offset);
        offset += 1;
        const constraints: ColumnDef["constraints"] = [];
        if (constraintFlags & 0x01) constraints.push("PRIMARY_KEY");
        if (constraintFlags & 0x02) constraints.push("NOT_NULL");
        if (constraintFlags & 0x04) constraints.push("UNIQUE");

        columns.push({ name: colName, type: colType, constraints });
      }

      // ルートページ番号
      const rootPageNum = page.readUInt32LE(offset);
      offset += 4;

      const tableLower = name.toLowerCase();
      this.tables.set(tableLower, { name, columns, rootPageNum });
      this.btrees.set(tableLower, BTree.open(this.pager, rootPageNum));
    }

    return { success: true, message: "Schema loaded" };
  }
```

スキーマページ (通常ページ1) からテーブル定義を逐次パースし、`tables` マップと `btrees` マップの両方を構築します。

#### saveSchema() -- スキーマの書き込み

```typescript
// src/db/database.ts:401-454
private saveSchema(): QueryResult {
    const header = this.pager.getHeader();
    const page = Buffer.alloc(this.pager.getPageSize(), 0);

    page.writeUInt8(PAGE_TYPE.SCHEMA, 0);
    page.writeUInt16LE(this.tables.size, 1);

    let offset = 3;

    for (const schema of this.tables.values()) {
      // テーブル名
      const nameBuf = Buffer.from(schema.name, "utf-8");
      page.writeUInt16LE(nameBuf.length, offset);
      offset += 2;
      nameBuf.copy(page, offset);
      offset += nameBuf.length;

      // カラム数
      page.writeUInt16LE(schema.columns.length, offset);
      offset += 2;

      for (const col of schema.columns) {
        // カラム名
        const colNameBuf = Buffer.from(col.name, "utf-8");
        page.writeUInt16LE(colNameBuf.length, offset);
        offset += 2;
        colNameBuf.copy(page, offset);
        offset += colNameBuf.length;

        // 型
        page.writeUInt8(COLUMN_TYPE_MAP[col.type] ?? 0x02, offset);
        offset += 1;

        // 制約フラグ
        let flags = 0;
        if (col.constraints.includes("PRIMARY_KEY")) flags |= 0x01;
        if (col.constraints.includes("NOT_NULL")) flags |= 0x02;
        if (col.constraints.includes("UNIQUE")) flags |= 0x04;
        page.writeUInt8(flags, offset);
        offset += 1;
      }

      // ルートページ番号
      page.writeUInt32LE(schema.rootPageNum, offset);
      offset += 4;
    }

    const writeResult = this.pager.writePage(header.schemaPage, page);
    if (!writeResult.success) {
      return { success: false, error: writeResult.error };
    }

    return { success: true, message: "Schema saved" };
  }
```

`loadSchema()` の逆操作です。メモリ上の `tables` マップの全エントリをバイナリ化してスキーマページに書き込みます。

**具体例:** テーブル `users(id INTEGER PRIMARY KEY, name TEXT NOT NULL)` のスキーマバイナリ

```
オフセット  バイト列                 説明
0x00        01                      pageType = Schema
0x01        01 00                   tableCount = 1
0x03        05 00                   テーブル名長 = 5
0x05        75 73 65 72 73          "users"
0x0A        02 00                   カラム数 = 2
0x0C        02 00                   カラム名長 = 2
0x0E        69 64                   "id"
0x10        01                      型 = INTEGER
0x11        03                      制約 = PRIMARY_KEY | NOT_NULL (0x01|0x02)
0x12        04 00                   カラム名長 = 4
0x14        6E 61 6D 65             "name"
0x18        02                      型 = TEXT
0x19        02                      制約 = NOT_NULL (0x02)
0x1A        02 00 00 00             rootPageNum = 2
```

---

### 4-3-4 CREATE TABLE の実行

> **この節で理解できること:** CREATE TABLE 文がスキーマとストレージにどう反映されるか。

#### executeCreate() のフロー

```typescript
// src/db/database.ts:117-153
private executeCreate(stmt: CreateTableStatement): QueryResult {
    const tableName = stmt.tableName.toLowerCase();

    if (this.tables.has(tableName)) {
      return { success: false, error: `Table '${stmt.tableName}' already exists` };
    }

    // PRIMARY KEY は最大1つ
    const pkCount = stmt.columns.filter((c) =>
      c.constraints.includes("PRIMARY_KEY"),
    ).length;
    if (pkCount > 1) {
      return { success: false, error: "Table can only have one PRIMARY KEY" };
    }

    // B+Tree を作成
    const treeResult = BTree.create(this.pager);
    if (!treeResult.success) {
      return { success: false, error: treeResult.error };
    }

    const tree = treeResult.data;
    const schema: TableSchema = {
      name: stmt.tableName,
      columns: stmt.columns,
      rootPageNum: tree.getRootPageNum(),
    };

    this.tables.set(tableName, schema);
    this.btrees.set(tableName, tree);

    // スキーマページを更新
    const saveResult = this.saveSchema();
    if (!saveResult.success) return saveResult;

    return { success: true, message: `Table '${stmt.tableName}' created` };
  }
```

**フロー:**

1. **テーブル名重複チェック (case-insensitive):** テーブル名を小文字化して `tables` マップで存在確認
2. **PRIMARY KEY 個数制限:** カラム定義に `PRIMARY_KEY` 制約が2つ以上あればエラー
3. **B+Tree 作成:** `BTree.create(this.pager)` で空のリーフノードを持つ新しいツリーを作成
4. **メモリキャッシュに登録:** `tables` と `btrees` の両方にエントリを追加
5. **スキーマページ保存:** `saveSchema()` でスキーマの永続化

---

### 4-3-5 INSERT INTO の実行

> **この節で理解できること:** INSERT 文の値検証、型変換、AUTO-INCREMENT、B+Tree への挿入の全体フロー。

#### executeInsert() のフロー

```typescript
// src/db/database.ts:159-248
private executeInsert(stmt: InsertStatement): QueryResult {
    const tableName = stmt.tableName.toLowerCase();
    const schema = this.tables.get(tableName);
    if (!schema) {
      return { success: false, error: `Table '${stmt.tableName}' does not exist` };
    }

    const tree = this.btrees.get(tableName);
    if (!tree) {
      return { success: false, error: `B+Tree not found for table '${stmt.tableName}'` };
    }

    // カラム数と値の数が一致するか
    if (stmt.columns.length !== stmt.values.length) {
      return {
        success: false,
        error: `Column count (${stmt.columns.length}) does not match value count (${stmt.values.length})`,
      };
    }

    // カラム名を検証し、値を組み立てる
    const columnMap = new Map<string, number>();
    for (let i = 0; i < schema.columns.length; i++) {
      columnMap.set(schema.columns[i].name.toLowerCase(), i);
    }

    // スキーマ順の値配列を作る (未指定カラムは null)
    const values: ColumnValue[] = new Array(schema.columns.length).fill(null);
    let keyValue: number | null = null;

    for (let i = 0; i < stmt.columns.length; i++) {
      const colIdx = columnMap.get(stmt.columns[i].toLowerCase());
      if (colIdx === undefined) {
        return { success: false, error: `Column '${stmt.columns[i]}' does not exist in table '${stmt.tableName}'` };
      }

      const colDef = schema.columns[colIdx];
      const rawValue = stmt.values[i];

      // 型チェックと変換
      const converted = convertValue(colDef, rawValue);
      if (!converted.success) return converted;
      values[colIdx] = converted.value;

      // PRIMARY KEY カラムからキーを取得
      if (colDef.constraints.includes("PRIMARY_KEY")) {
        if (typeof converted.value !== "number") {
          return { success: false, error: `PRIMARY KEY column '${colDef.name}' must be INTEGER` };
        }
        keyValue = converted.value;
      }
    }

    // NOT NULL チェック
    for (let i = 0; i < schema.columns.length; i++) {
      const colDef = schema.columns[i];
      if (colDef.constraints.includes("NOT_NULL") && values[i] === null) {
        return { success: false, error: `Column '${colDef.name}' cannot be null` };
      }
    }

    // PRIMARY KEY がない場合は auto-increment 的に連番を生成
    if (keyValue === null) {
      const scanResult = tree.scan();
      if (!scanResult.success) {
        return { success: false, error: scanResult.error };
      }
      keyValue = scanResult.data.length > 0
        ? Math.max(...scanResult.data.map((r) => r.key)) + 1
        : 1;
    }

    // B+Tree に挿入
    const insertResult = tree.insert({ key: keyValue, values });
    if (!insertResult.success) {
      if (insertResult.error.includes("Duplicate key")) {
        return { success: false, error: `Duplicate PRIMARY KEY value: ${keyValue}` };
      }
      return { success: false, error: insertResult.error };
    }

    // ルートページが変わった可能性があるのでスキーマを更新
    const currentSchema = this.tables.get(tableName)!;
    if (currentSchema.rootPageNum !== tree.getRootPageNum()) {
      currentSchema.rootPageNum = tree.getRootPageNum();
      this.saveSchema();
    }

    return { success: true, message: "1 row inserted" };
  }
```

**フロー (7ステップ):**

1. **テーブル存在確認:** テーブル名を小文字化して `tables` と `btrees` から取得
2. **カラム検証:** INSERT 文で指定されたカラム名がスキーマに存在するかを確認
3. **型変換:** `convertValue()` で各値を型に応じて変換
4. **NOT NULL チェック:** スキーマで `NOT_NULL` 制約のあるカラムが null のままならエラー
5. **AUTO-INCREMENT キー生成:** PRIMARY KEY が指定されていなければ `scan()` で全件走査し `max(key) + 1` を生成
6. **B+Tree へ挿入:** `tree.insert()` でレコードを挿入。重複キーエラーは専用メッセージに変換
7. **ルートページ更新:** 分割によりルートページが変わった場合、スキーマを再保存

#### convertValue() -- 型変換ヘルパー

```typescript
// src/db/database.ts:461-478
function convertValue(
  colDef: ColumnDef,
  raw: string | number,
): { success: true; value: ColumnValue } | { success: false; error: string } {
  if (colDef.type === "INTEGER") {
    if (typeof raw === "number") {
      return { success: true, value: raw };
    }
    const num = Number(raw);
    if (Number.isNaN(num) || !Number.isInteger(num)) {
      return { success: false, error: `Invalid INTEGER value for column '${colDef.name}': ${raw}` };
    }
    return { success: true, value: num };
  }

  // TEXT
  return { success: true, value: String(raw) };
}
```

- INTEGER カラム: 数値ならそのまま、文字列なら `Number()` で変換。整数でなければエラー。
- TEXT カラム: `String()` で文字列化。

---

### 4-3-6 SELECT の実行

> **この節で理解できること:** SELECT 文の全件スキャン、WHERE フィルタリング、カラムプロジェクションの仕組み。

#### executeSelect() のフロー

```typescript
// src/db/database.ts:254-337
private executeSelect(stmt: SelectStatement): QueryResult {
    const tableName = stmt.tableName.toLowerCase();
    const schema = this.tables.get(tableName);
    if (!schema) {
      return { success: false, error: `Table '${stmt.tableName}' does not exist` };
    }

    const tree = this.btrees.get(tableName);
    if (!tree) {
      return { success: false, error: `B+Tree not found for table '${stmt.tableName}'` };
    }

    // 全レコードを取得
    const scanResult = tree.scan();
    if (!scanResult.success) {
      return { success: false, error: scanResult.error };
    }

    // カラム名リストを決定
    const allColumnNames = schema.columns.map((c) => c.name);
    const isSelectAll = stmt.columns.length === 1 && stmt.columns[0] === "*";

    const selectedColumns: string[] = isSelectAll
      ? allColumnNames
      : stmt.columns.map((col) => {
          const found = allColumnNames.find(
            (c) => c.toLowerCase() === col.toLowerCase(),
          );
          return found ?? col;
        });

    // 存在しないカラムのチェック
    if (!isSelectAll) {
      for (const col of selectedColumns) {
        if (!allColumnNames.find((c) => c.toLowerCase() === col.toLowerCase())) {
          return { success: false, error: `Column '${col}' does not exist in table '${stmt.tableName}'` };
        }
      }
    }

    // B+Tree のレコードを Record 形式に変換
    let records: Record[] = scanResult.data.map((btreeRecord) => {
      const record: Record = {};
      for (let i = 0; i < allColumnNames.length; i++) {
        record[allColumnNames[i]] = btreeRecord.values[i] ?? null;
      }
      return record;
    });

    // WHERE フィルタリング
    if (Object.keys(stmt.where).length > 0) {
      records = records.filter((record) => {
        for (const [col, condition] of Object.entries(stmt.where)) {
          const actualCol = allColumnNames.find(
            (c) => c.toLowerCase() === col.toLowerCase(),
          );
          if (!actualCol) return false;

          const recordValue = record[actualCol];
          if (!matchesCondition(recordValue, condition.operator, condition.value)) {
            return false;
          }
        }
        return true;
      });
    }

    // 指定カラムだけに絞る
    const projectedRecords = records.map((record) => {
      const projected: Record = {};
      for (const col of selectedColumns) {
        projected[col] = record[col] ?? null;
      }
      return projected;
    });

    return {
      success: true,
      message: `${projectedRecords.length} row(s) found`,
      columns: selectedColumns,
      records: projectedRecords,
    };
  }
```

**フロー (5ステップ):**

1. **全件スキャン:** `tree.scan()` で B+Tree の全レコードをキー順に取得
2. **Record 形式への変換:** BTreeRecord (キー+値配列) をカラム名付きオブジェクトに変換
3. **WHERE フィルタリング:** `matchesCondition()` で各条件をチェックし、全条件を満たすレコードだけを残す
4. **カラムプロジェクション:** `SELECT *` なら全カラム、指定されたカラム名だけなら該当カラムのみの Record を構築
5. **結果返却:** 行数、カラム名リスト、レコード配列を含む QueryResult を返す

#### matchesCondition() -- WHERE フィルタリングの型比較ロジック

```typescript
// src/db/database.ts:480-519
function matchesCondition(
  recordValue: ColumnValue,
  operator: string,
  conditionValue: string | number,
): boolean {
  if (recordValue === null) {
    return false;
  }

  // 型を揃える
  let a: number | string = recordValue as number | string;
  let b: number | string = conditionValue;

  // 両方数値に変換可能なら数値比較
  if (typeof a === "number" && typeof b === "string") {
    const bNum = Number(b);
    if (!Number.isNaN(bNum)) b = bNum;
  }
  if (typeof a === "string" && typeof b === "number") {
    const aNum = Number(a);
    if (!Number.isNaN(aNum)) a = aNum;
  }

  switch (operator) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    default:
      return false;
  }
}
```

**型比較のルール:**

1. レコード値が `null` なら常に `false` (NULL はどんな比較でもマッチしない)
2. 型が異なる場合、数値変換を試みる:
   - レコードが `number` で条件が `string` → 条件側を `Number()` で変換
   - レコードが `string` で条件が `number` → レコード側を `Number()` で変換
3. 型が揃ったら JavaScript の比較演算子で評価

対応する演算子: `=`, `!=`, `>`, `<`, `>=`, `<=`

**具体例:** `SELECT * FROM users WHERE age > 20`

```
レコード: { name: "Alice", age: 25 }
  recordValue = 25 (number), operator = ">", conditionValue = 20 (number)
  → 25 > 20 = true → マッチ

レコード: { name: "Bob", age: 18 }
  recordValue = 18 (number), operator = ">", conditionValue = 20 (number)
  → 18 > 20 = false → 除外

レコード: { name: "Charlie", age: null }
  recordValue = null → 即 false → 除外
```

#### カラムプロジェクション

SELECT で指定されたカラムだけを抽出します。

```typescript
// src/db/database.ts:323-329
const projectedRecords = records.map((record) => {
      const projected: Record = {};
      for (const col of selectedColumns) {
        projected[col] = record[col] ?? null;
      }
      return projected;
    });
```

`SELECT name FROM users` であれば、`selectedColumns = ["name"]` となり、`id` や `age` カラムは結果に含まれません。`SELECT *` の場合は `allColumnNames` がそのまま使われるため、全カラムが結果に含まれます。
