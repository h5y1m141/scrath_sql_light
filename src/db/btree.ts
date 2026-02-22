import { Pager, PAGE_TYPE } from "../storage/pager.ts";
import type { PageType } from "../storage/pager.ts";

// ============================================================
// 型定義
// ============================================================

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

/** 分割が発生した場合の昇格情報 */
type SplitResult =
  | { split: false }
  | { split: true; promotedKey: number; newPageNum: number };

// ============================================================
// ページレイアウト定数
//
// リーフノード:
//   [0]      u8   ページタイプ (0x02)
//   [1..2]   u16  セル数
//   [3..6]   u32  右兄弟ページ番号 (0 = なし)
//   [7..]    セルの配列 (各セルは可変長)
//
// 内部ノード:
//   [0]      u8   ページタイプ (0x03)
//   [1..2]   u16  キー数
//   [3..6]   u32  最左子ページ番号
//   [7..]    (キー u32 + 子ページ番号 u32) ペアの配列
// ============================================================

const NODE_HEADER_SIZE = 7;
const INTERNAL_ENTRY_SIZE = 8; // キー(4) + 子ページ番号(4)

// ============================================================
// B+Tree クラス
// ============================================================

export class BTree {
  private pager: Pager;
  private rootPageNum: number;
  private maxLeafCells: number;
  private maxInternalKeys: number;

  constructor(pager: Pager, rootPageNum: number) {
    this.pager = pager;
    this.rootPageNum = rootPageNum;

    // 学習目的で小さめにして分割を観察しやすくする
    this.maxLeafCells = 4;
    this.maxInternalKeys = 4;
  }

  /**
   * 新しい空の B+Tree を作成し、ルートページを割り当てる
   */
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

  /**
   * 既存の B+Tree をルートページ番号から復元
   */
  static open(pager: Pager, rootPageNum: number): BTree {
    return new BTree(pager, rootPageNum);
  }

  getRootPageNum(): number {
    return this.rootPageNum;
  }

  // ============================================================
  // INSERT — パス追跡方式
  //
  // 1. ルートからリーフまでの経路(path)を記録しながら降りる
  // 2. リーフにレコードを挿入
  // 3. リーフがオーバーフローしたら分割 → 昇格キーを親に挿入
  // 4. 親もオーバーフローしたら分割を繰り返す
  // 5. ルートまで到達したら新しいルートを作成
  // ============================================================

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

  /**
   * ルートからリーフまで降りながらパスを記録
   */
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

  /**
   * リーフノードを分割
   */
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

  /**
   * 分割の昇格キーを親方向に伝播
   */
  private propagateSplit(
    path: number[],
    promotedKey: number,
    newChildPageNum: number,
  ): BTreeResult<void> {
    if (path.length === 0) {
      // パスが空 = ルートリーフが分割された → 新しいルートを作る
      // 現在のルートページ番号が左、newChildPageNum が右
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

  /**
   * 内部ノードを分割
   */
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

    // 昇格キーと新ページを返す（ルート処理は propagateSplit が担当）
    return { success: true, data: { promotedKey, newPageNum } };
  }

  /**
   * 新しいルートノードを作成
   */
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

  // ============================================================
  // SEARCH
  // ============================================================

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

  // ============================================================
  // SCAN (全件取得)
  // ============================================================

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

  // ============================================================
  // 内部ノードヘルパー
  // ============================================================

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

  /**
   * 内部ノードのエントリ(キー+子ページ番号)を読み出す
   */
  private readInternalEntries(page: Buffer): { key: number; childPageNum: number }[] {
    const keyCount = page.readUInt16LE(1);
    const entries: { key: number; childPageNum: number }[] = [];

    for (let i = 0; i < keyCount; i++) {
      const offset = NODE_HEADER_SIZE + i * INTERNAL_ENTRY_SIZE;
      entries.push({
        key: page.readUInt32LE(offset),
        childPageNum: page.readUInt32LE(offset + 4),
      });
    }

    return entries;
  }

  /**
   * 内部ノードを書き込む
   */
  private writeInternalNode(
    page: Buffer,
    leftmostChild: number,
    entries: { key: number; childPageNum: number }[],
  ): void {
    page.writeUInt8(PAGE_TYPE.INTERNAL_NODE, 0);
    page.writeUInt16LE(entries.length, 1);
    page.writeUInt32LE(leftmostChild, 3);

    for (let i = 0; i < entries.length; i++) {
      const offset = NODE_HEADER_SIZE + i * INTERNAL_ENTRY_SIZE;
      page.writeUInt32LE(entries[i].key, offset);
      page.writeUInt32LE(entries[i].childPageNum, offset + 4);
    }
  }

  // ============================================================
  // リーフセルのシリアライズ / デシリアライズ
  //
  // セル形式:
  //   [key]        u32 (4 bytes)
  //   [valueCount] u16 (2 bytes)
  //   [values...]  各値:
  //     型タグ u8: 0x00=NULL, 0x01=INTEGER, 0x02=TEXT
  //     INTEGER: i32 (4 bytes, LE)
  //     TEXT:    u16 長さ + N bytes UTF-8
  // ============================================================

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
}
