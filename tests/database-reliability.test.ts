import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginWriteTransaction,
  createDatabaseBackup,
  configureSqliteReliability,
  restoreDatabaseBackup,
  validateDatabaseFile,
} from "../src/database-reliability.ts";

describe("SQLite 備份與還原", () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it("creates an integrity-checked online backup and restores it atomically", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "lbth-reliability-"));
    const databasePath = join(temporaryDirectory, "game.sqlite");
    const backupPath = join(temporaryDirectory, "backups", "game.sqlite");
    const source = new DatabaseSync(databasePath);
    configureSqliteReliability(source, 1_234);
    source.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    source.prepare("INSERT INTO records (value) VALUES (?)").run("before-backup");

    expect(source.prepare("PRAGMA busy_timeout").get()).toEqual({
      timeout: 1_234,
    });
    expect(source.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });

    const backup = await createDatabaseBackup(source, backupPath);
    source.prepare("INSERT INTO records (value) VALUES (?)").run("after-backup");
    source.close();

    expect(backup.integrityCheck).toBe("ok");
    expect(await validateDatabaseFile(backupPath)).toBe("ok");
    await restoreDatabaseBackup(backupPath, databasePath);

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM records").all()).toEqual([
        { value: "before-backup" },
      ]);
      expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      restored.close();
    }
  });

  it("rejects corrupt backups without replacing the existing database", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "lbth-reliability-"));
    const databasePath = join(temporaryDirectory, "game.sqlite");
    const invalidBackupPath = join(temporaryDirectory, "invalid.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE records (value TEXT NOT NULL)");
    database.prepare("INSERT INTO records (value) VALUES ('preserve-me')").run();
    database.close();
    writeFileSync(invalidBackupPath, Buffer.from("not a SQLite database"));

    await expect(
      restoreDatabaseBackup(invalidBackupPath, databasePath),
    ).rejects.toThrow();
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("SELECT value FROM records").get()).toEqual({
        value: "preserve-me",
      });
    } finally {
      preserved.close();
    }
  });

  it("retries a busy write transaction until the competing writer releases its lock", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "lbth-reliability-"));
    const databasePath = join(temporaryDirectory, "locked.sqlite");
    const seed = new DatabaseSync(databasePath);
    seed.exec("CREATE TABLE records (value TEXT)");
    seed.close();
    const database = new DatabaseSync(databasePath);
    configureSqliteReliability(database, 10);
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const { DatabaseSync } = require("node:sqlite");
       const database = new DatabaseSync(workerData);
       database.exec("BEGIN IMMEDIATE");
       parentPort.postMessage("locked");
       setTimeout(() => {
         database.exec("ROLLBACK");
         database.close();
         parentPort.postMessage("released");
       }, 90);`,
      { eval: true, workerData: databasePath },
    );
    const messages: string[] = [];
    worker.on("message", (message: string) => messages.push(message));
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (message: string) =>
        message === "locked" ? resolve() : reject(new Error("Writer did not lock")),
      );
      worker.once("error", reject);
    });
    try {
      beginWriteTransaction(database, 5);
      database.prepare("INSERT INTO records (value) VALUES ('retried')").run();
      database.exec("COMMIT");
      expect(database.prepare("SELECT COUNT(*) AS count FROM records").get()).toEqual({
        count: 1,
      });
    } finally {
      database.close();
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    }
    expect(messages).toEqual(["locked", "released"]);
  });
});
