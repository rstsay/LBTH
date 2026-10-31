import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { SmtpMagicLinkSender } from "./email.ts";
import { createAuthApp, initializeAuthSchema } from "./auth.ts";
import { runDataRetentionCleanup } from "./retention.ts";
import { pauseStalePlayerGameSessions } from "./games.ts";
import {
  configureSqliteReliability,
  createDatabaseBackup,
} from "./database-reliability.ts";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not configured`);
  }
  return value;
}

function positiveIntegerEnvironmentVariable(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerEnvironmentVariable(
  name: string,
  fallback: number,
): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }
  return value;
}

function isLocalOnlyHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10 || first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254);
}

const databasePath = resolve(process.env.DATABASE_PATH ?? "./data/lbth.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
configureSqliteReliability(database);
initializeAuthSchema(database);

const smtpUser = process.env.SMTP_USER?.trim();
const smtpPassword = process.env.SMTP_PASSWORD;
if ((smtpUser && !smtpPassword) || (!smtpUser && smtpPassword)) {
  throw new Error("SMTP_USER and SMTP_PASSWORD must be configured together");
}

const mailer = new SmtpMagicLinkSender(requiredEnvironmentVariable("SMTP_FROM"), {
  host: requiredEnvironmentVariable("SMTP_HOST"),
  port: positiveIntegerEnvironmentVariable("SMTP_PORT", 587),
  secure: process.env.SMTP_SECURE === "true",
  ...(smtpUser && smtpPassword ? { user: smtpUser, password: smtpPassword } : {}),
});
const publicAppUrl = requiredEnvironmentVariable("PUBLIC_APP_URL");
if (process.env.NODE_ENV !== "production" && isLocalOnlyHostname(new URL(publicAppUrl).hostname)) {
  console.warn("PUBLIC_APP_URL 使用 localhost 或區域網路位址；外網裝置無法開啟 Email Magic Link，請改用可公開連線的測試網域。");
}
const app = createAuthApp({
  database,
  mailer,
  publicAppUrl,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() ?? "",
  adminBootstrapEmail: requiredEnvironmentVariable("ADMIN_BOOTSTRAP_EMAIL"),
  adminTotpEncryptionKey: process.env.ADMIN_TOTP_ENCRYPTION_KEY?.trim(),
  authHandoffEncryptionKey: process.env.AUTH_HANDOFF_ENCRYPTION_KEY?.trim(),
  trustProxyHops: nonNegativeIntegerEnvironmentVariable(
    "TRUST_PROXY_HOPS",
    0,
  ),
});
const backupDirectory = resolve(process.env.BACKUP_DIRECTORY ?? "./backups");
const backupIntervalMs = positiveIntegerEnvironmentVariable(
  "BACKUP_INTERVAL_MS",
  24 * 60 * 60 * 1000,
);
let backupOperation: Promise<void> | undefined;
const createScheduledBackup = (): void => {
  if (backupOperation) {
    return;
  }
  const backupName = `lbth-${new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-")}.sqlite`;
  backupOperation = createDatabaseBackup(
    database,
    join(backupDirectory, backupName),
  )
    .then(({ path }) => {
      console.log(`SQLite 備份完成：${path}`);
    })
    .catch((error: unknown) => {
      console.error("SQLite 備份失敗：", error);
    })
    .finally(() => {
      backupOperation = undefined;
    });
};
createScheduledBackup();
const backupTimer = setInterval(createScheduledBackup, backupIntervalMs);
backupTimer.unref();
const retentionCleanupTimer = setInterval(() => {
  try {
    runDataRetentionCleanup(database, Date.now());
  } catch (error) {
    console.error("資料保留清理作業失敗：", error);
  }
}, 60 * 1000);
retentionCleanupTimer.unref();
const playerGameSessionTimer = setInterval(() => {
  try {
    pauseStalePlayerGameSessions(database, Date.now());
  } catch (error) {
    console.error("玩家遊戲回合心跳清理失敗：", error);
  }
}, 15 * 1000);
playerGameSessionTimer.unref();
try {
  pauseStalePlayerGameSessions(database, Date.now());
} catch (error) {
  console.error("啟動時檢查玩家遊戲回合失敗：", error);
}
try {
  runDataRetentionCleanup(database, Date.now());
} catch (error) {
  console.error("啟動時資料保留清理作業失敗：", error);
}
const server = createServer(app);
const port = positiveIntegerEnvironmentVariable("PORT", 3000);

server.on("error", (error) => {
  console.error("HTTP server failed:", error);
  database.close();
  process.exitCode = 1;
});

server.listen(port, () => {
  console.log(`LBS Treasure Hunt API listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(backupTimer);
    clearInterval(retentionCleanupTimer);
    clearInterval(playerGameSessionTimer);
    server.close(async (error) => {
      if (error) {
        console.error("HTTP server shutdown failed:", error);
        process.exitCode = 1;
      }
      await backupOperation;
      database.close();
    });
  });
}
