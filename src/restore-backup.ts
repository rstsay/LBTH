import "dotenv/config";
import { resolve } from "node:path";
import { restoreDatabaseBackup } from "./database-reliability.ts";

const backupArgument = process.argv[2];
const databasePath = resolve(
  process.env.DATABASE_PATH ?? "./data/lbth.sqlite",
);

if (!backupArgument) {
  throw new Error("請提供要還原的 SQLite 備份檔路徑。");
}

const backupPath = resolve(backupArgument);
await restoreDatabaseBackup(backupPath, databasePath);
console.log(`資料庫已從已驗證備份還原：${databasePath}`);
