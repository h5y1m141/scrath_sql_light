import { describe, test, expect, afterEach } from "bun:test";
import { Pager, PAGE_TYPE } from "./pager.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/test_pager.db";

afterEach(() => {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
});

// ============================================================
// ファイル作成とヘッダー
// ============================================================

describe("ファイル作成とヘッダー", () => {
  test("新規ファイル作成時にヘッダーが正しく書き込まれる", () => {
    const result = Pager.open(TEST_DB);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pager = result.data;
    const header = pager.getHeader();

    expect(header.magic).toBe(0x53514c54); // "SQLT"
    expect(header.pageSize).toBe(4096);
    expect(header.totalPages).toBe(2); // ヘッダー + スキーマ
    expect(header.schemaPage).toBe(1);

    pager.close();
  });

  test("既存ファイルを再オープンしてヘッダーが読める", () => {
    // 作成して閉じる
    const result1 = Pager.open(TEST_DB);
    expect(result1.success).toBe(true);
    if (!result1.success) return;
    result1.data.close();

    // 再オープン
    const result2 = Pager.open(TEST_DB);
    expect(result2.success).toBe(true);
    if (!result2.success) return;

    const header = result2.data.getHeader();
    expect(header.magic).toBe(0x53514c54);
    expect(header.pageSize).toBe(4096);
    expect(header.totalPages).toBe(2);

    result2.data.close();
  });

  test("スキーマページが初期化されている", () => {
    const result = Pager.open(TEST_DB);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pager = result.data;
    const pageResult = pager.readPage(1);
    expect(pageResult.success).toBe(true);
    if (!pageResult.success) return;

    const page = pageResult.data;
    expect(page.readUInt8(0)).toBe(PAGE_TYPE.SCHEMA); // ページタイプ
    expect(page.readUInt16LE(1)).toBe(0);              // テーブル数 = 0

    pager.close();
  });

  test("カスタムページサイズ", () => {
    const result = Pager.open(TEST_DB, 8192);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.getPageSize()).toBe(8192);
    result.data.close();
  });
});

// ============================================================
// ページ割り当て
// ============================================================

describe("ページ割り当て", () => {
  test("allocatePage で連番のページ番号が返る", () => {
    const result = Pager.open(TEST_DB);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pager = result.data;

    // 初期状態: ページ0(ヘッダー) + ページ1(スキーマ) = totalPages 2
    const page2 = pager.allocatePage();
    expect(page2.success).toBe(true);
    if (page2.success) expect(page2.data).toBe(2);

    const page3 = pager.allocatePage();
    expect(page3.success).toBe(true);
    if (page3.success) expect(page3.data).toBe(3);

    const page4 = pager.allocatePage();
    expect(page4.success).toBe(true);
    if (page4.success) expect(page4.data).toBe(4);

    expect(pager.getHeader().totalPages).toBe(5);

    pager.close();
  });

  test("割り当て後のページ数がファイル再オープンで維持される", () => {
    const result1 = Pager.open(TEST_DB);
    expect(result1.success).toBe(true);
    if (!result1.success) return;

    result1.data.allocatePage(); // page 2
    result1.data.allocatePage(); // page 3
    result1.data.close();

    const result2 = Pager.open(TEST_DB);
    expect(result2.success).toBe(true);
    if (!result2.success) return;

    expect(result2.data.getHeader().totalPages).toBe(4);
    result2.data.close();
  });
});

// ============================================================
// ページ読み書き
// ============================================================

describe("ページ読み書き", () => {
  test("writePage → readPage のラウンドトリップ", () => {
    const result = Pager.open(TEST_DB);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pager = result.data;
    const allocResult = pager.allocatePage();
    expect(allocResult.success).toBe(true);
    if (!allocResult.success) return;

    const pageNum = allocResult.data;

    // テストデータを書き込む
    const data = Buffer.alloc(4096, 0);
    data.writeUInt8(PAGE_TYPE.LEAF_NODE, 0);
    data.writeUInt16LE(42, 1);   // セル数 = 42
    data.write("Hello, SQLight!", 7, "utf-8");

    const writeResult = pager.writePage(pageNum, data);
    expect(writeResult.success).toBe(true);

    // 読み戻す
    const readResult = pager.readPage(pageNum);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;

    expect(readResult.data.readUInt8(0)).toBe(PAGE_TYPE.LEAF_NODE);
    expect(readResult.data.readUInt16LE(1)).toBe(42);
    expect(readResult.data.toString("utf-8", 7, 7 + "Hello, SQLight!".length)).toBe("Hello, SQLight!");

    pager.close();
  });

  test("ファイルを閉じて再オープンしてもデータが残る", () => {
    // 書き込み
    const result1 = Pager.open(TEST_DB);
    expect(result1.success).toBe(true);
    if (!result1.success) return;

    const pager1 = result1.data;
    const allocResult = pager1.allocatePage();
    expect(allocResult.success).toBe(true);
    if (!allocResult.success) return;

    const pageNum = allocResult.data;
    const data = Buffer.alloc(4096, 0);
    data.writeUInt8(PAGE_TYPE.INTERNAL_NODE, 0);
    data.writeUInt32LE(12345, 4);
    pager1.writePage(pageNum, data);
    pager1.close();

    // 再オープンして読み出し
    const result2 = Pager.open(TEST_DB);
    expect(result2.success).toBe(true);
    if (!result2.success) return;

    const readResult = result2.data.readPage(pageNum);
    expect(readResult.success).toBe(true);
    if (!readResult.success) return;

    expect(readResult.data.readUInt8(0)).toBe(PAGE_TYPE.INTERNAL_NODE);
    expect(readResult.data.readUInt32LE(4)).toBe(12345);

    result2.data.close();
  });

  test("範囲外のページ番号でエラー", () => {
    const result = Pager.open(TEST_DB);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pager = result.data;

    const readResult = pager.readPage(999);
    expect(readResult.success).toBe(false);

    const writeResult = pager.writePage(999, Buffer.alloc(4096));
    expect(writeResult.success).toBe(false);

    pager.close();
  });

  test("バッファサイズ不一致でエラー", () => {
    const result = Pager.open(TEST_DB);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const pager = result.data;
    const allocResult = pager.allocatePage();
    expect(allocResult.success).toBe(true);
    if (!allocResult.success) return;

    const writeResult = pager.writePage(allocResult.data, Buffer.alloc(100));
    expect(writeResult.success).toBe(false);

    pager.close();
  });
});
