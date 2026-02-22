import { openSync, closeSync, readSync, writeSync, fstatSync, type BunFile } from "fs";
import { existsSync } from "node:fs";

// ============================================================
// 型定義
// ============================================================

export type PageType =
  | 0x00   // Unused
  | 0x01   // Schema
  | 0x02   // LeafNode
  | 0x03;  // InternalNode

export const PAGE_TYPE = {
  UNUSED: 0x00 as PageType,
  SCHEMA: 0x01 as PageType,
  LEAF_NODE: 0x02 as PageType,
  INTERNAL_NODE: 0x03 as PageType,
} as const;

export type FileHeader = {
  magic: number;         // 0x53514C54 ("SQLT")
  pageSize: number;      // デフォルト 4096
  totalPages: number;    // ファイル内の総ページ数
  schemaPage: number;    // スキーマページ番号 (通常 1)
};

export type PagerResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ============================================================
// 定数
// ============================================================

const MAGIC_NUMBER = 0x53514C54; // "SQLT"
const DEFAULT_PAGE_SIZE = 4096;

// ファイルヘッダーレイアウト
const HEADER_MAGIC_OFFSET = 0;
const HEADER_MAGIC_SIZE = 4;
const HEADER_PAGE_SIZE_OFFSET = 4;
const HEADER_PAGE_SIZE_SIZE = 2;
const HEADER_TOTAL_PAGES_OFFSET = 6;
const HEADER_TOTAL_PAGES_SIZE = 4;
const HEADER_SCHEMA_PAGE_OFFSET = 10;
const HEADER_SCHEMA_PAGE_SIZE = 4;
const FILE_HEADER_SIZE = 14;

// ============================================================
// Pager クラス
// ============================================================

export class Pager {
  private fd: number;
  private header: FileHeader;
  private readonly pageSize: number;

  private constructor(fd: number, header: FileHeader) {
    this.fd = fd;
    this.header = header;
    this.pageSize = header.pageSize;
  }

  /**
   * データベースファイルを開く（なければ新規作成）
   */
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

  /**
   * 新しいページを割り当てて、そのページ番号を返す
   */
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

  /**
   * 指定ページ番号のデータを読み込む
   */
  readPage(pageNum: number): PagerResult<Buffer> {
    if (pageNum < 0 || pageNum >= this.header.totalPages) {
      return { success: false, error: `Page ${pageNum} out of range (0..${this.header.totalPages - 1})` };
    }

    const buf = Buffer.alloc(this.pageSize);
    const offset = pageNum * this.pageSize;
    readSync(this.fd, buf, 0, this.pageSize, offset);

    return { success: true, data: buf };
  }

  /**
   * 指定ページ番号にデータを書き込む
   */
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

  /**
   * ファイルヘッダー情報を取得
   */
  getHeader(): FileHeader {
    return { ...this.header };
  }

  /**
   * ページサイズを取得
   */
  getPageSize(): number {
    return this.pageSize;
  }

  /**
   * ファイルを閉じる
   */
  close(): void {
    this.flushHeader();
    closeSync(this.fd);
  }

  // --- private ---

  private writePageRaw(pageNum: number, data: Buffer): void {
    const offset = pageNum * this.pageSize;
    writeSync(this.fd, data, 0, this.pageSize, offset);
  }

  private flushHeader(): void {
    const headerPage = Buffer.alloc(this.pageSize, 0);
    writeFileHeader(headerPage, this.header);
    this.writePageRaw(0, headerPage);
  }
}

// ============================================================
// ヘッダー読み書きヘルパー
// ============================================================

function writeFileHeader(buf: Buffer, header: FileHeader): void {
  buf.writeUInt32LE(header.magic, HEADER_MAGIC_OFFSET);
  buf.writeUInt16LE(header.pageSize, HEADER_PAGE_SIZE_OFFSET);
  buf.writeUInt32LE(header.totalPages, HEADER_TOTAL_PAGES_OFFSET);
  buf.writeUInt32LE(header.schemaPage, HEADER_SCHEMA_PAGE_OFFSET);
}

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
