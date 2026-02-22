import { parse } from "./sql/parser.ts";
import { Database } from "./db/database.ts";
import type { Record as DbRecord } from "./db/database.ts";

const PROMPT = "> ";
const CONTINUATION = "... ";
const DB_FILE = "sqlight.db";

function printWelcome(): void {
  console.log("");
  console.log("  SQLight — A lightweight SQLite clone in TypeScript");
  console.log("  Type SQL statements ending with ';' to execute them.");
  console.log("  Press Ctrl+D to exit.");
  console.log(`  Database file: ${DB_FILE}`);
  console.log("");
}

/**
 * SELECT結果をテーブル形式で表示
 */
function printTable(columns: string[], records: DbRecord[]): void {
  if (records.length === 0) {
    console.log("(0 rows)");
    return;
  }

  // 各カラムの最大幅を計算
  const widths = columns.map((col) => col.length);
  for (const record of records) {
    for (let i = 0; i < columns.length; i++) {
      const val = formatValue(record[columns[i]]);
      widths[i] = Math.max(widths[i], val.length);
    }
  }

  // ヘッダー
  const border = "+" + widths.map((w) => "-".repeat(w + 2) + "+").join("");
  const header =
    "|" + columns.map((col, i) => ` ${col.padEnd(widths[i])} |`).join("");

  console.log(border);
  console.log(header);
  console.log(border);

  // レコード
  for (const record of records) {
    const row =
      "|" +
      columns
        .map((col, i) => {
          const val = formatValue(record[col]);
          return ` ${val.padEnd(widths[i])} |`;
        })
        .join("");
    console.log(row);
  }

  console.log(border);
  console.log(`(${records.length} row${records.length === 1 ? "" : "s"})`);
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  return String(val);
}

async function main(): Promise<void> {
  printWelcome();

  // データベースを開く
  const openResult = Database.open(DB_FILE);
  if (!openResult.success || !openResult.db) {
    console.error(`Error: ${openResult.success ? "Unknown error" : openResult.error}`);
    process.exit(1);
  }
  const db = openResult.db;

  process.stdout.write(PROMPT);

  let currentInput = "";

  for await (const line of console) {
    const trimmed = line.trim();

    // 空行はスキップ
    if (trimmed === "" && currentInput === "") {
      process.stdout.write(PROMPT);
      continue;
    }

    // 入力を蓄積
    currentInput += (currentInput ? "\n" : "") + line;

    // セミコロンで終わるまで継続入力
    if (!currentInput.trimEnd().endsWith(";")) {
      process.stdout.write(CONTINUATION);
      continue;
    }

    // パース
    const parseResult = parse(currentInput);
    if (!parseResult.success) {
      console.log(`Error: ${parseResult.error}`);
      console.log("");
      currentInput = "";
      process.stdout.write(PROMPT);
      continue;
    }

    // 実行
    const execResult = db.execute(parseResult.statement);
    if (!execResult.success) {
      console.log(`Error: ${execResult.error}`);
    } else if (execResult.columns && execResult.records) {
      // SELECT 結果をテーブル表示
      printTable(execResult.columns, execResult.records);
    } else {
      console.log(execResult.message);
    }

    console.log("");
    currentInput = "";
    process.stdout.write(PROMPT);
  }

  db.close();
  console.log("\nBye!");
}

main();
