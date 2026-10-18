import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_WRITE_RETRY_COUNT = 3;
const WRITE_RETRY_DELAY_MS = 50;

export function configureSqliteReliability(
  database: DatabaseSync,
  busyTimeoutMilliseconds = DEFAULT_BUSY_TIMEOUT_MS,
): void {
  if (
    !Number.isSafeInteger(busyTimeoutMilliseconds) ||
    busyTimeoutMilliseconds < 0
  ) {
    throw new Error("SQLite busy timeout must be a non-negative integer");
  }
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMilliseconds}`);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    error.message.includes("database is locked") ||
    error.message.includes("database table is locked")
  );
}

export function beginWriteTransaction(
  database: DatabaseSync,
  retryCount = DEFAULT_WRITE_RETRY_COUNT,
): void {
  if (!Number.isSafeInteger(retryCount) || retryCount < 0) {
    throw new Error("SQLite write retry count must be a non-negative integer");
  }
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= retryCount) {
        throw error;
      }
      Atomics.wait(waitBuffer, 0, 0, WRITE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function integrityCheck(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | undefined;
    if (result?.integrity_check !== "ok") {
      throw new Error(
        `SQLite integrity check failed for ${databasePath}: ${result?.integrity_check ?? "no result"}`,
      );
    }
    const foreignKeyViolation = database
      .prepare("PRAGMA foreign_key_check")
      .get();
    if (foreignKeyViolation) {
      throw new Error(`SQLite foreign key check failed for ${databasePath}`);
    }
    return result.integrity_check;
  } finally {
    database.close();
  }
}

export async function validateDatabaseFile(databasePath: string): Promise<"ok"> {
  return integrityCheck(databasePath) as "ok";
}

export async function createDatabaseBackup(
  database: DatabaseSync,
  destinationPath: string,
): Promise<{ path: string; integrityCheck: "ok" }> {
  mkdirSync(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`;
  try {
    await backup(database, temporaryPath);
    const verified = await validateDatabaseFile(temporaryPath);
    renameSync(temporaryPath, destinationPath);
    return { path: destinationPath, integrityCheck: verified };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export async function restoreDatabaseBackup(
  backupPath: string,
  databasePath: string,
): Promise<void> {
  if (backupPath === databasePath) {
    throw new Error("Backup and destination database paths must be different");
  }
  if (
    existsSync(`${databasePath}-wal`) ||
    existsSync(`${databasePath}-shm`)
  ) {
    throw new Error(
      "Stop the application and close the database before restoring a backup",
    );
  }
  await validateDatabaseFile(backupPath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.${randomUUID()}.restore`;
  try {
    copyFileSync(backupPath, temporaryPath);
    await validateDatabaseFile(temporaryPath);
    renameSync(temporaryPath, databasePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}
