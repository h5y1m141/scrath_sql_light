import { describe, test, expect, afterEach } from "bun:test";
import { BTree } from "./btree.ts";
import type { BTreeRecord } from "./btree.ts";
import { Pager } from "../storage/pager.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/test_btree.db";

afterEach(() => {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
});

function createTestTree(): { pager: Pager; tree: BTree } {
  const pagerResult = Pager.open(TEST_DB);
  if (!pagerResult.success) throw new Error(pagerResult.error);

  const treeResult = BTree.create(pagerResult.data);
  if (!treeResult.success) throw new Error(treeResult.error);

  return { pager: pagerResult.data, tree: treeResult.data };
}

// ============================================================
// INSERT + SEARCH
// ============================================================

describe("INSERT + SEARCH", () => {
  test("単一レコードの insert → search", () => {
    const { pager, tree } = createTestTree();

    const insertResult = tree.insert({ key: 1, values: [1, "Alice"] });
    expect(insertResult.success).toBe(true);

    const searchResult = tree.search(1);
    expect(searchResult.success).toBe(true);
    if (!searchResult.success) return;

    expect(searchResult.data).not.toBeNull();
    expect(searchResult.data!.key).toBe(1);
    expect(searchResult.data!.values).toEqual([1, "Alice"]);

    pager.close();
  });

  test("複数レコードの insert → 各キーで search", () => {
    const { pager, tree } = createTestTree();

    tree.insert({ key: 3, values: [3, "Charlie"] });
    tree.insert({ key: 1, values: [1, "Alice"] });
    tree.insert({ key: 2, values: [2, "Bob"] });

    for (const [key, name] of [[1, "Alice"], [2, "Bob"], [3, "Charlie"]] as [number, string][]) {
      const result = tree.search(key);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toBeNull();
        expect(result.data!.key).toBe(key);
        expect(result.data!.values[1]).toBe(name);
      }
    }

    pager.close();
  });

  test("存在しないキーの search → null", () => {
    const { pager, tree } = createTestTree();

    tree.insert({ key: 1, values: [1, "Alice"] });

    const result = tree.search(999);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
    }

    pager.close();
  });

  test("重複キーの insert → エラー", () => {
    const { pager, tree } = createTestTree();

    tree.insert({ key: 1, values: [1, "Alice"] });
    const result = tree.insert({ key: 1, values: [1, "Duplicate"] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Duplicate key");
    }

    pager.close();
  });

  test("NULL 値を含むレコード", () => {
    const { pager, tree } = createTestTree();

    tree.insert({ key: 1, values: [1, null] });

    const result = tree.search(1);
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.values).toEqual([1, null]);
    }

    pager.close();
  });
});

// ============================================================
// SCAN (全件取得)
// ============================================================

describe("SCAN", () => {
  test("複数レコード insert → scan で全件取得（キー昇順）", () => {
    const { pager, tree } = createTestTree();

    tree.insert({ key: 3, values: [3, "Charlie"] });
    tree.insert({ key: 1, values: [1, "Alice"] });
    tree.insert({ key: 4, values: [4, "Dave"] });
    tree.insert({ key: 2, values: [2, "Bob"] });

    const result = tree.scan();
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(4);
    expect(result.data.map((r) => r.key)).toEqual([1, 2, 3, 4]);
    expect(result.data.map((r) => r.values[1])).toEqual([
      "Alice",
      "Bob",
      "Charlie",
      "Dave",
    ]);

    pager.close();
  });

  test("空のツリーを scan → 空配列", () => {
    const { pager, tree } = createTestTree();

    const result = tree.scan();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }

    pager.close();
  });
});

// ============================================================
// ノード分割
// ============================================================

describe("ノード分割", () => {
  test("maxLeafCells(4)を超える挿入でリーフが分割される", () => {
    const { pager, tree } = createTestTree();

    // 5件挿入 → maxLeafCells(4) を超えて分割が発生
    for (let i = 1; i <= 5; i++) {
      const result = tree.insert({ key: i, values: [i, `Name${i}`] });
      expect(result.success).toBe(true);
    }

    // 全件取得できること
    const scanResult = tree.scan();
    expect(scanResult.success).toBe(true);
    if (!scanResult.success) return;

    expect(scanResult.data).toHaveLength(5);
    expect(scanResult.data.map((r) => r.key)).toEqual([1, 2, 3, 4, 5]);

    pager.close();
  });

  test("多数のレコード挿入でも全件取得できる", () => {
    const { pager, tree } = createTestTree();

    const count = 20;
    for (let i = 1; i <= count; i++) {
      const result = tree.insert({ key: i, values: [i, `User${i}`] });
      expect(result.success).toBe(true);
    }

    const scanResult = tree.scan();
    expect(scanResult.success).toBe(true);
    if (!scanResult.success) return;

    expect(scanResult.data).toHaveLength(count);
    expect(scanResult.data.map((r) => r.key)).toEqual(
      Array.from({ length: count }, (_, i) => i + 1),
    );

    pager.close();
  });

  test("逆順挿入でも正しくソートされる", () => {
    const { pager, tree } = createTestTree();

    for (let i = 10; i >= 1; i--) {
      tree.insert({ key: i, values: [i, `User${i}`] });
    }

    const scanResult = tree.scan();
    expect(scanResult.success).toBe(true);
    if (!scanResult.success) return;

    expect(scanResult.data.map((r) => r.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    pager.close();
  });
});

// ============================================================
// 永続化 (ファイル再オープン)
// ============================================================

describe("永続化", () => {
  test("ファイル再オープン後も B+Tree のデータが残存", () => {
    // 書き込み
    const { pager: pager1, tree: tree1 } = createTestTree();
    const rootPageNum = tree1.getRootPageNum();

    tree1.insert({ key: 1, values: [1, "Alice"] });
    tree1.insert({ key: 2, values: [2, "Bob"] });
    tree1.insert({ key: 3, values: [3, "Charlie"] });

    pager1.close();

    // 再オープン
    const pagerResult = Pager.open(TEST_DB);
    expect(pagerResult.success).toBe(true);
    if (!pagerResult.success) return;

    const tree2 = BTree.open(pagerResult.data, rootPageNum);

    // search
    const searchResult = tree2.search(2);
    expect(searchResult.success).toBe(true);
    if (searchResult.success) {
      expect(searchResult.data).not.toBeNull();
      expect(searchResult.data!.values).toEqual([2, "Bob"]);
    }

    // scan
    const scanResult = tree2.scan();
    expect(scanResult.success).toBe(true);
    if (scanResult.success) {
      expect(scanResult.data).toHaveLength(3);
      expect(scanResult.data.map((r) => r.key)).toEqual([1, 2, 3]);
    }

    pagerResult.data.close();
  });

  test("分割後のデータもファイル再オープンで残存", () => {
    // 分割を発生させる
    const { pager: pager1, tree: tree1 } = createTestTree();

    for (let i = 1; i <= 10; i++) {
      tree1.insert({ key: i, values: [i, `Name${i}`] });
    }
    const rootPageNum = tree1.getRootPageNum();
    pager1.close();

    // 再オープン
    const pagerResult = Pager.open(TEST_DB);
    expect(pagerResult.success).toBe(true);
    if (!pagerResult.success) return;

    const tree2 = BTree.open(pagerResult.data, rootPageNum);

    const scanResult = tree2.scan();
    expect(scanResult.success).toBe(true);
    if (scanResult.success) {
      expect(scanResult.data).toHaveLength(10);
      expect(scanResult.data.map((r) => r.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    pagerResult.data.close();
  });
});
