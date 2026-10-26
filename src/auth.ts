import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import validator from "validator";
import { fileURLToPath } from "node:url";
import {
  configureSqliteReliability,
  beginWriteTransaction,
} from "./database-reliability.ts";
import {
  createRateLimitMiddleware,
  initializeRateLimitSchema,
} from "./rate-limit.ts";
import {
  archivePlayerEvents,
  initializeDataRetentionSchema,
  recordDataRetentionAudit,
} from "./retention.ts";
import {
  createAdminGameRouter,
  createPlayerGameRouter,
  createPlayerSessionMiddleware,
  pauseStalePlayerGameSessions,
  PLAYER_GAME_HEARTBEAT_TIMEOUT_MS,
  initializeGameSchema,
  type AdminAuthorizer,
} from "./games.ts";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE_NAME = "player_session";
const TRUSTED_DEVICE_COOKIE_NAME = "player_trusted_device";
const TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const ADMIN_SESSION_COOKIE_NAME = "admin_session";
const ADMIN_TRUSTED_DEVICE_COOKIE_NAME = "admin_trusted_device";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface MagicLinkSender {
  send(email: string, url: string): Promise<void>;
}

export interface AuthAppOptions {
  database: DatabaseSync;
  mailer: MagicLinkSender;
  publicAppUrl: string;
  googleMapsApiKey?: string;
  now?: () => number;
  createToken?: () => string;
  createId?: () => string;
  secureCookies?: boolean;
  authorizeAdmin?: AdminAuthorizer;
  getAdminActorId?: (request: Request) => string | undefined;
  adminBootstrapEmail?: string;
  adminTotpEncryptionKey?: string;
  trustProxyHops?: number;
}

interface MagicLinkRecord {
  token_hash: string;
  email: string;
  expires_at: number;
  consumed_at: number | null;
}

interface PlayerRecord {
  id: string;
  email: string;
  anonymous_code: string;
  email_verified_at: number;
  nickname: string | null;
  leaderboard_visible: number;
}

export class EmailDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Magic Link Email could not be delivered", { cause });
    this.name = "EmailDeliveryError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function initializeAuthSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      anonymous_code TEXT NOT NULL UNIQUE,
      email_verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      nickname TEXT,
      leaderboard_visible INTEGER NOT NULL DEFAULT 1 CHECK(leaderboard_visible IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS magic_links_email_idx
      ON magic_links(email);

    CREATE TABLE IF NOT EXISTS player_sessions (
      token_hash TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      device_token_hash TEXT,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS player_trusted_devices (
      token_hash TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS player_trusted_devices_player_idx
      ON player_trusted_devices(player_id, revoked_at);

    CREATE TABLE IF NOT EXISTS administrators (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'auditor')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      totp_secret_encrypted TEXT,
      totp_last_counter INTEGER,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      disabled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS admin_magic_links (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES administrators(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS admin_auth_challenges (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES administrators(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      enrollment_secret_encrypted TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES administrators(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS admin_sessions_admin_active_idx
      ON admin_sessions(admin_id, expires_at)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS admin_trusted_devices (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES administrators(id),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS admin_trusted_devices_admin_idx
      ON admin_trusted_devices(admin_id, revoked_at);

    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      result TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx
      ON admin_audit_log(created_at);
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS admin_audit_log_immutable_update
    BEFORE UPDATE ON admin_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'admin audit records are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS admin_audit_log_immutable_delete
    BEFORE DELETE ON admin_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'admin audit records are immutable');
    END;
  `);
  const playerColumns = database
    .prepare("PRAGMA table_info(players)")
    .all() as Array<{ name: string }>;
  if (!playerColumns.some((column) => column.name === "nickname")) {
    database.exec("ALTER TABLE players ADD COLUMN nickname TEXT");
  }
  if (!playerColumns.some((column) => column.name === "leaderboard_visible")) {
    database.exec(
      "ALTER TABLE players ADD COLUMN leaderboard_visible INTEGER NOT NULL DEFAULT 1 CHECK(leaderboard_visible IN (0, 1))",
    );
  }
  database.exec(
    "CREATE INDEX IF NOT EXISTS players_leaderboard_visible_idx ON players(leaderboard_visible)",
  );
  const playerSessionColumns = database
    .prepare("PRAGMA table_info(player_sessions)")
    .all() as Array<{ name: string }>;
  if (!playerSessionColumns.some((column) => column.name === "device_token_hash")) {
    database.exec("ALTER TABLE player_sessions ADD COLUMN device_token_hash TEXT");
  }
  database
    .prepare(
      `UPDATE player_sessions SET revoked_at = ?
       WHERE revoked_at IS NULL
         AND token_hash NOT IN (
           SELECT MAX(token_hash)
           FROM player_sessions
           WHERE revoked_at IS NULL
           GROUP BY player_id
         )`,
    )
    .run(Date.now());
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS player_sessions_one_active_per_player_idx
      ON player_sessions(player_id)
      WHERE revoked_at IS NULL;
  `);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setSessionCookie(response: Response, token: string, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) {
    attributes.push("Secure");
  }
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function setTrustedDeviceCookie(
  response: Response,
  token: string,
  secure: boolean,
): void {
  const attributes = [
    `${TRUSTED_DEVICE_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }
  response.append("Set-Cookie", attributes.join("; "));
}

function clearTrustedDeviceCookie(response: Response, secure: boolean): void {
  response.append(
    "Set-Cookie",
    `${TRUSTED_DEVICE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
      secure ? "; Secure" : ""
    }`,
  );
}

function setAdminTrustedDeviceCookie(
  response: Response,
  token: string,
  secure: boolean,
): void {
  const attributes = [
    `${ADMIN_TRUSTED_DEVICE_COOKIE_NAME}=${token}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${TRUSTED_DEVICE_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  response.append("Set-Cookie", attributes.join("; "));
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.header("cookie");
  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

function encodeBase32(value: Buffer): string {
  let bits = "";
  for (const byte of value) {
    bits += byte.toString(2).padStart(8, "0");
  }
  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) {
    const group = bits.slice(index, index + 5).padEnd(5, "0");
    encoded += BASE32_ALPHABET[Number.parseInt(group, 2)];
  }
  return encoded;
}

function decodeBase32(value: string): Buffer {
  let bits = "";
  for (const character of value.toUpperCase().replaceAll("=", "")) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error("Stored TOTP secret is invalid");
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpAtCounter(secret: string, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBytes)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function matchingTotpCounter(
  secret: string,
  code: unknown,
  timestamp: number,
  lastUsedCounter: number | null,
): number | undefined {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return undefined;
  }
  const currentCounter = Math.floor(timestamp / 30_000);
  for (const counter of [currentCounter, currentCounter - 1, currentCounter + 1]) {
    if (counter < 0 || (lastUsedCounter !== null && counter <= lastUsedCounter)) {
      continue;
    }
    const expected = Buffer.from(totpAtCounter(secret, counter));
    const supplied = Buffer.from(code);
    if (timingSafeEqual(expected, supplied)) {
      return counter;
    }
  }
  return undefined;
}

function encryptTotpSecret(secret: string, encryptionKey: string): string {
  const key = createHash("sha256").update(encryptionKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptTotpSecret(encrypted: string, encryptionKey: string): string {
  const [ivValue, tagValue, ciphertextValue] = encrypted.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Stored TOTP secret is invalid");
  }
  const key = createHash("sha256").update(encryptionKey).digest();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function adminSessionToken(request: Request): string | undefined {
  return readCookie(request, ADMIN_SESSION_COOKIE_NAME);
}

function createPlayer(
  database: DatabaseSync,
  email: string,
  now: number,
  createId: () => string,
): PlayerRecord {
  const existing = database
    .prepare(
      `SELECT id, email, anonymous_code, email_verified_at, nickname, leaderboard_visible
       FROM players WHERE email = ?`,
    )
    .get(email) as PlayerRecord | undefined;
  if (existing) {
    return existing;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const player: PlayerRecord = {
      id: createId(),
      email,
      anonymous_code: `玩家-${randomBytes(4).toString("hex").toUpperCase()}`,
      email_verified_at: now,
      nickname: null,
      leaderboard_visible: 1,
    };
    try {
      database
        .prepare(
          `INSERT INTO players (
            id, email, anonymous_code, email_verified_at, created_at, nickname, leaderboard_visible
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          player.id,
          player.email,
          player.anonymous_code,
          player.email_verified_at,
          now,
          player.nickname,
          player.leaderboard_visible,
        );
      return player;
    } catch (error) {
      const emailPlayer = database
        .prepare(
          `SELECT id, email, anonymous_code, email_verified_at, nickname, leaderboard_visible
           FROM players WHERE email = ?`,
        )
        .get(email) as PlayerRecord | undefined;
      if (emailPlayer) {
        return emailPlayer;
      }
      if (attempt === 4) {
        throw error;
      }
    }
  }

  throw new Error("Could not create a unique anonymous player code");
}

export function createAuthApp(options: AuthAppOptions): Express {
  configureSqliteReliability(options.database);
  initializeAuthSchema(options.database);
  initializeGameSchema(options.database);
  initializeDataRetentionSchema(options.database);
  initializeRateLimitSchema(options.database);

  const app = express();
  if (
    options.trustProxyHops !== undefined &&
    (!Number.isSafeInteger(options.trustProxyHops) || options.trustProxyHops < 0)
  ) {
    throw new Error("trustProxyHops must be a non-negative integer");
  }
  app.set("trust proxy", options.trustProxyHops ?? 0);
  const now = options.now ?? Date.now;
  const createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
  const createId = options.createId ?? randomUUID;
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === "production";
  const publicAppUrl = new URL(options.publicAppUrl);
  if (
    process.env.NODE_ENV === "production" &&
    publicAppUrl.protocol !== "https:"
  ) {
    throw new Error("PUBLIC_APP_URL must use HTTPS in production");
  }
  const magicLinkIpRateLimit = createRateLimitMiddleware(
    options.database,
    now,
    {
      limit: 5,
      windowMilliseconds: 15 * 60 * 1000,
      key: (request) =>
        `magic-link-ip:${request.ip ?? request.socket.remoteAddress ?? "unknown"}`,
      message: "登入連結請求過於頻繁，請稍後再試。",
    },
  );
  const magicLinkEmailRateLimit = createRateLimitMiddleware(
    options.database,
    now,
    {
      limit: 5,
      windowMilliseconds: 15 * 60 * 1000,
      key: (request) =>
        isRecord(request.body) && typeof request.body.email === "string"
          ? `magic-link-email:${normalizeEmail(request.body.email)}`
          : undefined,
      message: "此 Email 的登入連結請求過於頻繁，請稍後再試。",
    },
  );
  const locationRateLimit = createRateLimitMiddleware(
    options.database,
    now,
    {
      limit: 1,
      windowMilliseconds: 5_000,
      key: (_request, response) =>
        `location:${String(response.locals.playerId ?? "unauthenticated")}`,
      message: "位置回報過於頻繁，請稍後再試。",
    },
  );
  const collectionRateLimit = createRateLimitMiddleware(
    options.database,
    now,
    {
      limit: 10,
      windowMilliseconds: 60_000,
      key: (_request, response) =>
        `collection:${String(response.locals.playerId ?? "unauthenticated")}`,
      message: "搜集請求過於頻繁，請稍後再試。",
    },
  );
  if (options.adminBootstrapEmail) {
    const bootstrapEmail = normalizeEmail(options.adminBootstrapEmail);
    if (!validator.isEmail(bootstrapEmail)) {
      throw new Error("ADMIN_BOOTSTRAP_EMAIL must be a valid email address");
    }
    if (
      options.adminTotpEncryptionKey &&
      Buffer.byteLength(options.adminTotpEncryptionKey, "utf8") < 32
    ) {
      throw new Error("ADMIN_TOTP_ENCRYPTION_KEY must be at least 32 bytes");
    }
    options.database
      .prepare(
        `INSERT OR IGNORE INTO administrators (
          id, email, role, active, created_at
        ) VALUES (?, ?, 'owner', 1, ?)`,
      )
      .run(createId(), bootstrapEmail, now());
    const bootstrapAdmin = options.database
      .prepare("SELECT role FROM administrators WHERE email = ?")
      .get(bootstrapEmail) as { role: string } | undefined;
    if (bootstrapAdmin?.role !== "owner") {
      throw new Error("ADMIN_BOOTSTRAP_EMAIL must identify an owner administrator");
    }
  }
  const findAdminSession = (request: Request) => {
    const token = adminSessionToken(request);
    if (!token) {
      return undefined;
    }
    return options.database
      .prepare(
        `SELECT a.id, a.role
         FROM admin_sessions s
         JOIN administrators a ON a.id = s.admin_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL
           AND s.expires_at > ? AND a.active = 1`,
      )
      .get(hashToken(token), now()) as
      | { id: string; role: "owner" | "admin" | "auditor" }
      | undefined;
  };
  const getAuthenticatedAdminActorId = (request: Request): string | undefined =>
    options.getAdminActorId?.(request) ?? findAdminSession(request)?.id;
  const issueAdminSession = (
    adminId: string,
    response: Response,
    timestamp: number,
  ): void => {
    const token = createToken();
    options.database
      .prepare(
        `INSERT INTO admin_sessions (
          token_hash, admin_id, created_at, expires_at, revoked_at
        ) VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(
        hashToken(token),
        adminId,
        timestamp,
        timestamp + ADMIN_SESSION_TTL_MS,
      );
    const attributes = [
      `${ADMIN_SESSION_COOKIE_NAME}=${token}`,
      "Path=/admin",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`,
    ];
    if (secureCookies) {
      attributes.push("Secure");
    }
    response.append("Set-Cookie", attributes.join("; "));
  };
  const auditAdminRequest = (
    request: Request,
    response: Response,
    next: () => void,
  ): void => {
    const actorId =
      getAuthenticatedAdminActorId(request) ??
      (options.authorizeAdmin ? "injected-admin" : undefined);
    if (!actorId) {
      next();
      return;
    }
    response.on("finish", () => {
      const rawRoute = `${request.baseUrl}${request.path}`.replace(/\/{2,}/g, "/");
      const segments = rawRoute.split("/").filter(Boolean);
      const knownTargets = new Set([
        "games",
        "anomalies",
        "progress-resets",
        "players",
        "operations",
        "administrators",
        "audit-logs",
      ]);
      let targetIndex = -1;
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (knownTargets.has(segments[index]!)) {
          targetIndex = index;
          break;
        }
      }
      const targetType = targetIndex >= 0 ? segments[targetIndex]! : "admin";
      const candidateTargetId =
        targetIndex >= 0 ? segments[targetIndex + 1] : undefined;
      const queryGameId =
        targetType === "players" && typeof request.query.gameId === "string"
          ? request.query.gameId
          : undefined;
      const targetCandidate = candidateTargetId || queryGameId;
      const targetId =
        targetCandidate && /^[A-Za-z0-9_-]{1,128}$/.test(targetCandidate)
          ? targetCandidate
          : null;
      const route = `/${segments
        .map((segment) =>
          /^[A-Za-z0-9_-]{1,128}$/.test(segment) ? segment : ":value",
        )
        .join("/")}`;
      const changedFields = isRecord(request.body)
        ? Object.keys(request.body).filter((key) =>
            [
              "role",
              "active",
              "status",
              "decision",
              "confirmPermanentDeletion",
              "name",
              "description",
              "startsAt",
              "endsAt",
              "timezone",
              "mapCenter",
              "treasures",
              "title",
              "enabled",
              "fuzzyRadiusMeters",
              "sortOrder",
            ].includes(key),
          )
        : [];
      const safeChanges: Record<string, string | boolean> = {};
      if (isRecord(request.body)) {
        for (const key of [
          "role",
          "active",
          "status",
          "decision",
          "confirmPermanentDeletion",
        ]) {
          const value = request.body[key];
          if (
            typeof value === "string" &&
            [
              "owner",
              "admin",
              "auditor",
              "draft",
              "published",
              "active",
              "paused",
              "ended",
              "exited",
              "confirmed",
              "dismissed",
            ].includes(value)
          ) {
            safeChanges[key] = value;
          } else if (typeof value === "boolean") {
            safeChanges[key] = value;
          }
        }
      }
      try {
        options.database
          .prepare(
            `INSERT INTO admin_audit_log (
              id, actor_id, action, target_type, target_id, result,
              summary_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            createId(),
            actorId,
            `${request.method} ${route}`,
            targetType,
            targetId,
            response.statusCode >= 200 && response.statusCode < 400
              ? "success"
              : "failure",
            JSON.stringify({
              statusCode: response.statusCode,
              changedFields,
              changes: safeChanges,
            }),
            now(),
          );
      } catch (error) {
        console.error("管理員稽核紀錄寫入失敗：", error);
      }
    });
    next();
  };
  const authenticatedPlayer = (request: Request): PlayerRecord | undefined => {
    const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionToken) {
      return undefined;
    }
    return options.database
      .prepare(
        `SELECT p.id, p.email, p.anonymous_code, p.email_verified_at,
                p.nickname, p.leaderboard_visible
         FROM player_sessions s
         JOIN players p ON p.id = s.player_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
      )
      .get(hashToken(sessionToken)) as PlayerRecord | undefined;
  };
  const serializePlayer = (player: PlayerRecord): Record<string, unknown> => ({
    id: player.id,
    anonymousCode: player.anonymous_code,
    email: player.email,
    emailVerified: true,
    nickname: player.nickname,
    leaderboardVisible: player.leaderboard_visible === 1,
    currentGameId: (
      options.database
        .prepare(
          `SELECT game_id FROM game_participants
           WHERE player_id = ? AND status = 'playing'`,
        )
        .get(player.id) as { game_id: string } | undefined
    )?.game_id ?? null,
    totalCollectedSoFar: (
      options.database
        .prepare(
          "SELECT COUNT(*) AS count FROM collected_treasures WHERE player_id = ?",
        )
        .get(player.id) as { count: number }
    ).count,
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  const webDirectory = fileURLToPath(new URL("../web/", import.meta.url));
  app.get("/app/config.js", (_request, response) => {
    response
      .set({
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      })
      .send(
        `window.LBS_CONFIG = Object.freeze({ googleMapsApiKey: ${JSON.stringify(options.googleMapsApiKey ?? "")} });`,
      );
  });
  app.use("/app", express.static(webDirectory, { index: "index.html" }));
  app.get("/", (_request, response) => {
    response.type("html").send(`<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>LBS 虛擬尋寶 API</title>
    <style>
      body { margin: 0; padding: 2rem 1rem; background: #f4f7f5; color: #18332b; font: 16px/1.6 system-ui, sans-serif; }
      main { max-width: 40rem; margin: 8vh auto; padding: 2rem; border: 1px solid #d6e3dc; border-radius: 1rem; background: white; box-shadow: 0 1rem 3rem #18332b12; }
      h1 { margin-top: 0; }
      .status { color: #176b45; font-weight: 700; }
      li { margin: .6rem 0; }
      a { color: #145c9e; }
      code { padding: .15rem .35rem; border-radius: .25rem; background: #eef3f1; }
    </style>
  </head>
  <body>
    <main>
      <h1>LBS 虛擬尋寶</h1>
      <p class="status">API 服務運作中</p>
      <p>玩家與管理員網頁介面已就緒，請由此進入。</p>
      <p><a href="/app">開啟 LBS 虛擬尋寶</a></p>
      <h2>可試用的 API</h2>
      <ul>
        <li><a href="/leaderboard"><code>GET /leaderboard</code></a>：查看公開排行榜</li>
        <li><a href="/games"><code>GET /games</code></a>：查看已發布遊戲（需玩家登入）</li>
        <li><a href="/auth/me"><code>GET /auth/me</code></a>：查看目前登入狀態（需玩家登入）</li>
      </ul>
      <p>玩家登入需要設定可用的 SMTP 郵件服務，才能接收 Email 登入連結。</p>
    </main>
  </body>
</html>`);
  });

  app.post(
    "/admin/auth/magic-links",
    magicLinkIpRateLimit,
    magicLinkEmailRateLimit,
    async (request: Request, response: Response, next) => {
      if (!isRecord(request.body) || typeof request.body.email !== "string") {
        response.status(400).json({ error: "請提供有效的 Email。" });
        return;
      }
      const email = normalizeEmail(request.body.email);
      if (!validator.isEmail(email)) {
        response.status(400).json({ error: "請提供有效的 Email。" });
        return;
      }
      const admin = options.database
        .prepare("SELECT id FROM administrators WHERE email = ? AND active = 1")
        .get(email) as { id: string } | undefined;
      if (admin) {
        const trustedDeviceToken = readCookie(
          request,
          ADMIN_TRUSTED_DEVICE_COOKIE_NAME,
        );
        if (trustedDeviceToken) {
          const trustedDevice = options.database
            .prepare(
              `SELECT 1 FROM admin_trusted_devices d
               JOIN administrators a ON a.id = d.admin_id
               WHERE d.token_hash = ? AND d.admin_id = ? AND a.email = ?
                 AND d.revoked_at IS NULL AND a.active = 1`,
            )
            .get(hashToken(trustedDeviceToken), admin.id, email);
          if (trustedDevice) {
            response.status(202).json({
              trustedDevice: true,
              message: "此裝置已受信任，正在為你登入。",
            });
            return;
          }
        }
        const token = createToken();
        const tokenHash = hashToken(token);
        const timestamp = now();
        options.database
          .prepare(
            `INSERT INTO admin_magic_links (
              token_hash, admin_id, created_at, expires_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            tokenHash,
            admin.id,
            timestamp,
            timestamp + MAGIC_LINK_TTL_MS,
          );
        const verificationUrl = new URL("/admin/auth/verify", publicAppUrl);
        verificationUrl.searchParams.set("token", token);
        try {
          await options.mailer.send(email, verificationUrl.toString());
        } catch (error) {
          options.database
            .prepare("DELETE FROM admin_magic_links WHERE token_hash = ?")
            .run(tokenHash);
          next(new EmailDeliveryError(error));
          return;
        }
      }
      response.status(202).json({
        message: "若管理員帳號有效，系統將寄送首次裝置確認連結。",
      });
    },
  );

  app.get("/admin/auth/verify", (request: Request, response: Response) => {
    const token = request.query.token;
    if (typeof token !== "string" || token.length === 0) {
      response.status(400).type("text/plain").send("登入連結無效或已過期。");
      return;
    }
    response
      .set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      })
      .type("html")
      .send(
        `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>管理員登入｜LBS 虛擬尋寶</title>
    <link rel="stylesheet" href="/app/style.css">
    <script src="/app/verify.js" defer></script>
  </head>
  <body class="verification-page">
    <main class="auth-card">
      <img class="brand-logo" src="/app/mustard-seed-logo.png" alt="芥菜總會標誌">
      <p class="eyebrow">管理員登入</p>
      <h1>確認 Email</h1>
      <p class="muted">首次在此裝置確認後，即可登入管理工作區。</p>
      <form data-verification="admin">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button class="button button-primary" type="submit">確認並繼續</button>
      </form>
      <p class="form-error" role="alert" aria-live="polite"></p>
    </main>
  </body>
</html>`,
      );
  });

  app.post("/admin/auth/verify", (request: Request, response: Response) => {
    if (!isRecord(request.body) || typeof request.body.token !== "string") {
      response.status(400).json({ error: "登入連結無效或已過期。" });
      return;
    }
    const tokenHash = hashToken(request.body.token);
    const timestamp = now();
    beginWriteTransaction(options.database);
    try {
      const magicLink = options.database
        .prepare(
          `SELECT l.admin_id, l.expires_at, l.consumed_at
           FROM admin_magic_links l
           JOIN administrators a ON a.id = l.admin_id
           WHERE l.token_hash = ? AND a.active = 1`,
        )
        .get(tokenHash) as
        | {
            admin_id: string;
            expires_at: number;
            consumed_at: number | null;
          }
        | undefined;
      if (
        !magicLink ||
        magicLink.consumed_at !== null ||
        magicLink.expires_at <= timestamp
      ) {
        options.database.exec("ROLLBACK");
        response.status(410).json({ error: "登入連結無效或已過期。" });
        return;
      }
      options.database
        .prepare(
          `UPDATE admin_magic_links SET consumed_at = ?
           WHERE token_hash = ? AND consumed_at IS NULL`,
        )
        .run(timestamp, tokenHash);
      const trustedDeviceToken = createToken();
      options.database
        .prepare(
          `INSERT INTO admin_trusted_devices (
            token_hash, admin_id, created_at, last_seen_at, revoked_at
          ) VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(
          hashToken(trustedDeviceToken),
          magicLink.admin_id,
          timestamp,
          timestamp,
        );
      issueAdminSession(magicLink.admin_id, response, timestamp);
      setAdminTrustedDeviceCookie(response, trustedDeviceToken, secureCookies);
      options.database
        .prepare(
          `INSERT INTO admin_audit_log (
            id, actor_id, action, target_type, target_id, result,
            summary_json, created_at
          ) VALUES (?, ?, 'admin_email_login', 'administrator', ?, 'success', ?, ?)`,
        )
        .run(
          createId(),
          magicLink.admin_id,
          magicLink.admin_id,
          JSON.stringify({ method: "email_magic_link", deviceTrusted: true }),
          timestamp,
        );
      options.database.exec("COMMIT");
      response.setHeader("Cache-Control", "no-store");
      response.json({ authenticated: true });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  app.post(
    "/admin/auth/totp/enroll",
    (request: Request, response: Response) => {
      if (
        !isRecord(request.body) ||
        typeof request.body.challengeToken !== "string"
      ) {
        response.status(400).json({ error: "登入驗證程序無效或已過期。" });
        return;
      }
      if (!options.adminTotpEncryptionKey) {
        response.status(503).json({ error: "目前尚未設定 TOTP 密鑰加密金鑰。" });
        return;
      }
      const challenge = options.database
        .prepare(
          `SELECT c.admin_id, c.enrollment_secret_encrypted, a.email,
                  a.totp_secret_encrypted
           FROM admin_auth_challenges c
           JOIN administrators a ON a.id = c.admin_id
           WHERE c.token_hash = ? AND c.consumed_at IS NULL
             AND c.expires_at > ? AND a.active = 1`,
        )
        .get(hashToken(request.body.challengeToken), now()) as
        | {
            admin_id: string;
            enrollment_secret_encrypted: string | null;
            email: string;
            totp_secret_encrypted: string | null;
          }
        | undefined;
      if (!challenge) {
        response.status(410).json({ error: "登入驗證程序無效或已過期。" });
        return;
      }
      if (
        challenge.totp_secret_encrypted !== null ||
        challenge.enrollment_secret_encrypted !== null
      ) {
        response.status(409).json({ error: "此帳號已設定 TOTP 或已開始設定。" });
        return;
      }
      const secret = encodeBase32(randomBytes(20));
      options.database
        .prepare(
          `UPDATE admin_auth_challenges SET enrollment_secret_encrypted = ?
           WHERE token_hash = ? AND enrollment_secret_encrypted IS NULL`,
        )
        .run(
          encryptTotpSecret(secret, options.adminTotpEncryptionKey),
          hashToken(request.body.challengeToken),
        );
      const label = encodeURIComponent(`LBS Treasure Hunt:${challenge.email}`);
      const otpauthUrl =
        `otpauth://totp/${label}?secret=${secret}` +
        "&issuer=LBS%20Treasure%20Hunt&algorithm=SHA1&digits=6&period=30";
      response.setHeader("Cache-Control", "no-store");
      response.json({ secret, otpauthUrl });
    },
  );

  const completeAdminTotp = (
    request: Request,
    response: Response,
    enrollment: boolean,
  ): void => {
    if (
      !isRecord(request.body) ||
      typeof request.body.challengeToken !== "string"
    ) {
      response.status(400).json({ error: "登入驗證程序無效或已過期。" });
      return;
    }
    if (!options.adminTotpEncryptionKey) {
      response.status(503).json({ error: "目前尚未設定 TOTP 密鑰加密金鑰。" });
      return;
    }
    const tokenHash = hashToken(request.body.challengeToken);
    const timestamp = now();
    beginWriteTransaction(options.database);
    try {
      const challenge = options.database
        .prepare(
          `SELECT c.admin_id, c.enrollment_secret_encrypted,
                  a.totp_secret_encrypted, a.totp_last_counter, a.active
           FROM admin_auth_challenges c
           JOIN administrators a ON a.id = c.admin_id
           WHERE c.token_hash = ? AND c.consumed_at IS NULL
             AND c.expires_at > ?`,
        )
        .get(tokenHash, timestamp) as
        | {
            admin_id: string;
            enrollment_secret_encrypted: string | null;
            totp_secret_encrypted: string | null;
            totp_last_counter: number | null;
            active: number;
          }
        | undefined;
      if (!challenge || challenge.active !== 1) {
        options.database.exec("ROLLBACK");
        response.status(410).json({ error: "登入驗證程序無效或已過期。" });
        return;
      }
      if (enrollment !== (challenge.totp_secret_encrypted === null)) {
        options.database.exec("ROLLBACK");
        response.status(409).json({ error: "TOTP 設定狀態已變更，請重新登入。" });
        return;
      }
      const encryptedSecret = enrollment
        ? challenge.enrollment_secret_encrypted
        : challenge.totp_secret_encrypted;
      if (!encryptedSecret) {
        options.database.exec("ROLLBACK");
        response.status(409).json({ error: "請先設定 TOTP 驗證器。" });
        return;
      }
      const secret = decryptTotpSecret(
        encryptedSecret,
        options.adminTotpEncryptionKey,
      );
      const counter = matchingTotpCounter(
        secret,
        request.body.code,
        timestamp,
        enrollment ? null : challenge.totp_last_counter,
      );
      if (counter === undefined) {
        options.database.exec("ROLLBACK");
        options.database
          .prepare(
            `INSERT INTO admin_audit_log (
              id, actor_id, action, target_type, target_id, result,
              summary_json, created_at
            ) VALUES (?, ?, 'admin_totp_login', 'administrator', ?, 'failure', ?, ?)`,
          )
          .run(
            createId(),
            challenge.admin_id,
            challenge.admin_id,
            JSON.stringify({ method: "totp", enrollment }),
            timestamp,
          );
        response.status(401).json({ error: "TOTP 驗證碼無效或已使用。" });
        return;
      }
      if (enrollment) {
        options.database
          .prepare(
            `UPDATE administrators
             SET totp_secret_encrypted = ?, totp_last_counter = ?
             WHERE id = ? AND totp_secret_encrypted IS NULL`,
          )
          .run(
            encryptTotpSecret(secret, options.adminTotpEncryptionKey),
            counter,
            challenge.admin_id,
          );
      } else {
        options.database
          .prepare(
            "UPDATE administrators SET totp_last_counter = ? WHERE id = ?",
          )
          .run(counter, challenge.admin_id);
      }
      options.database
        .prepare(
          "UPDATE admin_auth_challenges SET consumed_at = ? WHERE token_hash = ?",
        )
        .run(timestamp, tokenHash);
      issueAdminSession(challenge.admin_id, response, timestamp);
      options.database
        .prepare(
          `INSERT INTO admin_audit_log (
            id, actor_id, action, target_type, target_id, result,
            summary_json, created_at
          ) VALUES (?, ?, 'admin_totp_login', 'administrator', ?, 'success', ?, ?)`,
        )
        .run(
          createId(),
          challenge.admin_id,
          challenge.admin_id,
          JSON.stringify({ method: "totp", enrollment }),
          timestamp,
        );
      options.database.exec("COMMIT");
      response.setHeader("Cache-Control", "no-store");
      response.json({ authenticated: true });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  };

  app.post("/admin/auth/totp/confirm", (request, response) => {
    completeAdminTotp(request, response, true);
  });
  app.post("/admin/auth/totp/verify", (request, response) => {
    completeAdminTotp(request, response, false);
  });
  app.post("/admin/auth/device-login", (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const trustedDeviceToken = readCookie(
      request,
      ADMIN_TRUSTED_DEVICE_COOKIE_NAME,
    );
    if (!trustedDeviceToken) {
      response.status(401).json({ error: "此裝置尚未確認 Email，請先完成一次確認。" });
      return;
    }
    const tokenHash = hashToken(trustedDeviceToken);
    const timestamp = now();
    const admin = options.database
      .prepare(
        `SELECT a.id, a.role FROM admin_trusted_devices d
         JOIN administrators a ON a.id = d.admin_id
         WHERE d.token_hash = ? AND d.revoked_at IS NULL AND a.active = 1`,
      )
      .get(tokenHash) as
      | { id: string; role: "owner" | "admin" | "auditor" }
      | undefined;
    if (!admin) {
      response.status(401).json({ error: "此裝置信任已失效，請重新確認 Email。" });
      return;
    }
    options.database
      .prepare(
        `UPDATE admin_trusted_devices SET last_seen_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(timestamp, tokenHash);
    issueAdminSession(admin.id, response, timestamp);
    options.database
      .prepare(
        `INSERT INTO admin_audit_log (
          id, actor_id, action, target_type, target_id, result,
          summary_json, created_at
        ) VALUES (?, ?, 'admin_trusted_device_login', 'administrator', ?, 'success', ?, ?)`,
      )
      .run(
        createId(),
        admin.id,
        admin.id,
        JSON.stringify({ method: "trusted_device" }),
        timestamp,
      );
    response.json({ authenticated: true, admin: { role: admin.role } });
  });
  app.post("/admin/auth/logout", (request: Request, response: Response) => {
    const token = adminSessionToken(request);
    if (token) {
      const session = options.database
        .prepare(
          `SELECT admin_id FROM admin_sessions
           WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(hashToken(token), now()) as { admin_id: string } | undefined;
      if (session) {
        options.database
          .prepare(
            `INSERT INTO admin_audit_log (
              id, actor_id, action, target_type, target_id, result,
              summary_json, created_at
            ) VALUES (?, ?, 'admin_logout', 'administrator', ?, 'success', '{}', ?)`,
          )
          .run(createId(), session.admin_id, session.admin_id, now());
      }
      options.database
        .prepare(
          `UPDATE admin_sessions SET revoked_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(now(), hashToken(token));
    }
    response.setHeader(
      "Set-Cookie",
      `${ADMIN_SESSION_COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${
        secureCookies ? "; Secure" : ""
      }`,
    );
    response.status(204).end();
  });

  app.post(
    "/auth/magic-links",
    magicLinkIpRateLimit,
    magicLinkEmailRateLimit,
    async (request: Request, response: Response, next) => {
      if (!isRecord(request.body) || typeof request.body.email !== "string") {
        response.status(400).json({ error: "請提供有效的 Email。" });
        return;
      }

      const email = normalizeEmail(request.body.email);
      if (!validator.isEmail(email)) {
        response.status(400).json({ error: "請提供有效的 Email。" });
        return;
      }

      const trustedDeviceToken = readCookie(
        request,
        TRUSTED_DEVICE_COOKIE_NAME,
      );
      if (trustedDeviceToken) {
        const alreadyTrusted = options.database
          .prepare(
            `SELECT 1 FROM player_trusted_devices d
             JOIN players p ON p.id = d.player_id
             WHERE d.token_hash = ? AND p.email = ? AND d.revoked_at IS NULL`,
          )
          .get(hashToken(trustedDeviceToken), email);
        if (alreadyTrusted) {
          response.status(202).json({
            trustedDevice: true,
            message: "此裝置已受信任，正在為你登入。",
          });
          return;
        }
      }

      const token = createToken();
      const tokenHash = hashToken(token);
      const timestamp = now();
      const expiresAt = timestamp + MAGIC_LINK_TTL_MS;
      options.database
        .prepare(
          `INSERT INTO magic_links (token_hash, email, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(tokenHash, email, timestamp, expiresAt);

      const verificationUrl = new URL("/auth/verify", publicAppUrl);
      verificationUrl.searchParams.set("token", token);

      try {
        await options.mailer.send(email, verificationUrl.toString());
      } catch (error) {
        options.database
          .prepare("DELETE FROM magic_links WHERE token_hash = ?")
          .run(tokenHash);
        next(new EmailDeliveryError(error));
        return;
      }

      response.status(202).json({
        message: "若此 Email 可用，系統將寄送一次性登入連結。",
      });
    },
  );

  app.get("/auth/verify", (request: Request, response: Response) => {
    const token = request.query.token;
    if (typeof token !== "string" || token.length === 0) {
      response.status(400).type("text/plain").send("登入連結無效或已過期。");
      return;
    }

    response
      .set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      })
      .type("html")
      .send(
        `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>確認登入｜LBS 虛擬尋寶</title>
    <link rel="stylesheet" href="/app/style.css">
    <script src="/app/verify.js" defer></script>
  </head>
  <body class="verification-page">
    <main class="auth-card">
      <img class="brand-logo" src="/app/mustard-seed-logo.png" alt="芥菜總會標誌">
      <p class="eyebrow">玩家登入</p>
      <h1>確認登入</h1>
      <p class="muted">按下按鈕完成 Email 驗證並返回尋寶地圖。</p>
      <form data-verification="player">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button class="button button-primary" type="submit">確認登入</button>
      </form>
      <p class="form-error" role="alert" aria-live="polite"></p>
    </main>
  </body>
</html>`,
      );
  });

  app.post("/auth/verify", (request: Request, response: Response) => {
    if (!isRecord(request.body) || typeof request.body.token !== "string") {
      response.status(400).json({ error: "登入連結無效或已過期。" });
      return;
    }

    const tokenHash = hashToken(request.body.token);
    const timestamp = now();
    pauseStalePlayerGameSessions(options.database, timestamp);
    beginWriteTransaction(options.database);
    try {
      const magicLink = options.database
        .prepare(
          `SELECT token_hash, email, expires_at, consumed_at
           FROM magic_links WHERE token_hash = ?`,
        )
        .get(tokenHash) as MagicLinkRecord | undefined;

      if (!magicLink || magicLink.consumed_at !== null || magicLink.expires_at <= timestamp) {
        options.database.exec("ROLLBACK");
        response.status(410).json({ error: "登入連結無效或已過期。" });
        return;
      }

      const existingPlayer = options.database
        .prepare("SELECT id FROM players WHERE email = ?")
        .get(magicLink.email) as { id: string } | undefined;
      if (existingPlayer) {
        const activeGame = options.database
          .prepare(
            `SELECT game_id, device_token_hash,
                    COALESCE(last_heartbeat_at, updated_at) AS last_heartbeat_at
             FROM game_participants WHERE player_id = ? AND status = 'playing'`,
          )
          .get(existingPlayer.id) as {
            game_id: string;
            device_token_hash: string | null;
            last_heartbeat_at: number;
          } | undefined;
        if (activeGame) {
          const stale = timestamp - activeGame.last_heartbeat_at >= PLAYER_GAME_HEARTBEAT_TIMEOUT_MS;
          if (!stale) {
            options.database.exec("ROLLBACK");
            response.status(409).json({
              code: "PLAYER_GAME_SESSION_ACTIVE",
              error: "玩家仍在另一裝置進行遊戲；請先暫停，或等待心跳逾時後再登入。",
            });
            return;
          }
          if (stale) {
            options.database
              .prepare(
                `UPDATE game_participants SET status = 'paused', device_token_hash = NULL,
                   last_heartbeat_at = NULL, updated_at = ?
                 WHERE game_id = ? AND player_id = ? AND status = 'playing'`,
              )
              .run(timestamp, activeGame.game_id, existingPlayer.id);
            options.database
              .prepare(
                `UPDATE location_samples SET expires_at = ?
                 WHERE game_id = ? AND player_id = ? AND expires_at IS NULL`,
              )
              .run(timestamp + 24 * 60 * 60 * 1000, activeGame.game_id, existingPlayer.id);
          }
        }
      }

      const consumed = options.database
        .prepare(
          `UPDATE magic_links SET consumed_at = ?
           WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(timestamp, tokenHash, timestamp);
      if (Number(consumed.changes) !== 1) {
        options.database.exec("ROLLBACK");
        response.status(410).json({ error: "登入連結無效或已過期。" });
        return;
      }

      const player = createPlayer(options.database, magicLink.email, timestamp, createId);
      const sessionToken = createToken();
      const trustedDeviceToken = createToken();
      options.database
        .prepare(
          "UPDATE player_sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL",
        )
        .run(timestamp, player.id);
      options.database
        .prepare(
          `INSERT INTO player_sessions (
            token_hash, player_id, device_token_hash, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(hashToken(sessionToken), player.id, hashToken(trustedDeviceToken), timestamp);
      options.database
        .prepare(
          `INSERT INTO player_trusted_devices (
            token_hash, player_id, created_at, last_seen_at, revoked_at
          ) VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(hashToken(trustedDeviceToken), player.id, timestamp, timestamp);

      options.database.exec("COMMIT");
      setSessionCookie(response, sessionToken, secureCookies);
      setTrustedDeviceCookie(response, trustedDeviceToken, secureCookies);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        player: {
          id: player.id,
          anonymousCode: player.anonymous_code,
          email: player.email,
          emailVerified: true,
        },
      });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  app.post("/auth/device-login", (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const trustedDeviceToken = readCookie(
      request,
      TRUSTED_DEVICE_COOKIE_NAME,
    );
    if (!trustedDeviceToken) {
      response.status(401).json({ error: "此裝置尚未完成 Email 確認。" });
      return;
    }

    const tokenHash = hashToken(trustedDeviceToken);
    const timestamp = now();
    const sessionToken = createToken();
    pauseStalePlayerGameSessions(options.database, timestamp);
    beginWriteTransaction(options.database);
    try {
      const player = options.database
        .prepare(
          `SELECT p.id, p.email, p.anonymous_code, p.email_verified_at,
                  p.nickname, p.leaderboard_visible
           FROM player_trusted_devices d
           JOIN players p ON p.id = d.player_id
           WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
        )
        .get(tokenHash) as PlayerRecord | undefined;
      if (!player) {
        options.database.exec("ROLLBACK");
        clearTrustedDeviceCookie(response, secureCookies);
        response.status(401).json({ error: "此裝置的信任已失效，請以 Email 確認。" });
        return;
      }

      const activeGame = options.database
        .prepare(
          `SELECT game_id, device_token_hash,
                  COALESCE(last_heartbeat_at, updated_at) AS last_heartbeat_at
           FROM game_participants WHERE player_id = ? AND status = 'playing'`,
        )
        .get(player.id) as {
          game_id: string;
          device_token_hash: string | null;
          last_heartbeat_at: number;
        } | undefined;
      if (activeGame) {
        const sameDevice = activeGame.device_token_hash === tokenHash;
        const stale = timestamp - activeGame.last_heartbeat_at >= PLAYER_GAME_HEARTBEAT_TIMEOUT_MS;
        if (!sameDevice && !stale) {
          options.database.exec("ROLLBACK");
          response.status(409).json({
            code: "PLAYER_GAME_SESSION_ACTIVE",
            error: "玩家仍在另一裝置進行遊戲；請先暫停，或等待心跳逾時後再登入。",
          });
          return;
        }
        if (stale) {
          options.database
            .prepare(
              `UPDATE game_participants SET status = 'paused', device_token_hash = NULL,
                 last_heartbeat_at = NULL, updated_at = ?
               WHERE game_id = ? AND player_id = ? AND status = 'playing'`,
            )
            .run(timestamp, activeGame.game_id, player.id);
          options.database
            .prepare(
              `UPDATE location_samples SET expires_at = ?
               WHERE game_id = ? AND player_id = ? AND expires_at IS NULL`,
            )
            .run(timestamp + 24 * 60 * 60 * 1000, activeGame.game_id, player.id);
        }
      }

      options.database
        .prepare(
          "UPDATE player_sessions SET revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL",
        )
        .run(timestamp, player.id);
      options.database
        .prepare(
          `INSERT INTO player_sessions (
            token_hash, player_id, device_token_hash, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, NULL)`,
        )
        .run(hashToken(sessionToken), player.id, tokenHash, timestamp);
      options.database
        .prepare(
          `UPDATE player_trusted_devices SET last_seen_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, tokenHash);
      options.database.exec("COMMIT");

      setSessionCookie(response, sessionToken, secureCookies);
      setTrustedDeviceCookie(response, trustedDeviceToken, secureCookies);
      response.json({
        player: {
          id: player.id,
          anonymousCode: player.anonymous_code,
          email: player.email,
          emailVerified: true,
        },
      });
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
  });

  app.get("/auth/me", (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const player = authenticatedPlayer(request);
    if (!player) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }

    const trustedDeviceToken = readCookie(
      request,
      TRUSTED_DEVICE_COOKIE_NAME,
    );
    if (trustedDeviceToken) {
      const trustedDevice = options.database
        .prepare(
          `SELECT 1 FROM player_trusted_devices
           WHERE token_hash = ? AND player_id = ? AND revoked_at IS NULL`,
        )
        .get(hashToken(trustedDeviceToken), player.id);
      if (trustedDevice) {
        setTrustedDeviceCookie(response, trustedDeviceToken, secureCookies);
      }
    }

    response.json({ player: serializePlayer(player) });
  });

  app.patch("/auth/me", (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const player = authenticatedPlayer(request);
    if (!player) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    if (
      !isRecord(request.body) ||
      Object.keys(request.body).length === 0 ||
      Object.keys(request.body).some(
        (key) => key !== "nickname" && key !== "leaderboardVisible",
      )
    ) {
      response.status(400).json({ error: "玩家資料更新欄位無效。" });
      return;
    }

    let nickname = player.nickname;
    if (Object.hasOwn(request.body, "nickname")) {
      const value = request.body.nickname;
      if (value !== null && typeof value !== "string") {
        response.status(400).json({ error: "暱稱必須是文字或 null。" });
        return;
      }
      const normalized = typeof value === "string" ? value.trim() : "";
      if (
        Array.from(normalized).length > 30 ||
        /[\u0000-\u001f\u007f]/.test(normalized)
      ) {
        response.status(400).json({ error: "暱稱不可超過 30 個字元或包含控制字元。" });
        return;
      }
      nickname = normalized.length === 0 ? null : normalized;
    }

    let leaderboardVisible = player.leaderboard_visible;
    if (Object.hasOwn(request.body, "leaderboardVisible")) {
      if (typeof request.body.leaderboardVisible !== "boolean") {
        response.status(400).json({ error: "排行榜顯示設定必須是布林值。" });
        return;
      }
      leaderboardVisible = request.body.leaderboardVisible ? 1 : 0;
    }

    options.database
      .prepare(
        "UPDATE players SET nickname = ?, leaderboard_visible = ? WHERE id = ?",
      )
      .run(nickname, leaderboardVisible, player.id);
    const updated = authenticatedPlayer(request);
    if (!updated) {
      throw new Error("Updated player could not be loaded");
    }
    response.json({ player: serializePlayer(updated) });
  });

  app.delete("/auth/me", (request: Request, response: Response) => {
    const player = authenticatedPlayer(request);
    if (!player) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    if (
      !isRecord(request.body) ||
      request.body.confirmPermanentDeletion !== true
    ) {
      response.status(400).json({
        error: "刪除帳號前，請明確確認 confirmPermanentDeletion。",
      });
      return;
    }
    const timestamp = now();
    beginWriteTransaction(options.database);
    try {
      archivePlayerEvents(options.database, player.id, timestamp);
      options.database
        .prepare("DELETE FROM magic_links WHERE email = ?")
        .run(player.email);
      options.database
        .prepare("DELETE FROM player_sessions WHERE player_id = ?")
        .run(player.id);
      options.database
        .prepare("DELETE FROM player_trusted_devices WHERE player_id = ?")
        .run(player.id);
      const deletion = options.database
        .prepare("DELETE FROM players WHERE id = ?")
        .run(player.id);
      if (Number(deletion.changes) !== 1) {
        throw new Error("Player account disappeared during deletion");
      }
      recordDataRetentionAudit(
        options.database,
        "player_account_deleted",
        player.id,
        timestamp,
      );
      options.database.exec("COMMIT");
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
        secureCookies ? "; Secure" : ""
      }`,
    );
    clearTrustedDeviceCookie(response, secureCookies);
    response.status(204).end();
  });

  const leaderboardRateLimit = createRateLimitMiddleware(
    options.database,
    now,
    {
      limit: 30,
      windowMilliseconds: 60_000,
      key: (request) => {
        const token = readCookie(request, SESSION_COOKIE_NAME);
        const player = token
          ? (options.database
              .prepare(
                `SELECT player_id FROM player_sessions
                 WHERE token_hash = ? AND revoked_at IS NULL`,
              )
              .get(hashToken(token)) as { player_id: string } | undefined)
          : undefined;
        return player
          ? `leaderboard-player:${player.player_id}`
          : `leaderboard-ip:${request.ip ?? request.socket.remoteAddress ?? "unknown"}`;
      },
      message: "排行榜查詢過於頻繁，請稍後再試。",
    },
  );
  app.get("/leaderboard", leaderboardRateLimit, (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const rows = options.database
      .prepare(
        `WITH collection_stats AS (
           SELECT player_id, COUNT(*) AS total_collected, MAX(collected_at) AS achieved_at
           FROM collected_treasures
           GROUP BY player_id
         ),
         per_game_progress AS (
           SELECT gp.player_id, gp.game_id,
                  (SELECT COUNT(*) FROM treasures t
                   WHERE t.game_id = gp.game_id AND t.enabled = 1) AS target_count,
                  (SELECT COUNT(*) FROM collected_treasures c
                   JOIN treasures t ON t.id = c.treasure_id AND t.game_id = c.game_id
                   WHERE c.game_id = gp.game_id AND c.player_id = gp.player_id
                     AND t.enabled = 1) AS collected_count
           FROM game_participants gp
         ),
         completed_games AS (
           SELECT player_id, COUNT(*) AS completed_count
           FROM per_game_progress
           WHERE target_count > 0 AND collected_count = target_count
           GROUP BY player_id
         )
         SELECT COALESCE(NULLIF(p.nickname, ''), p.anonymous_code) AS display_name,
                COALESCE(cs.total_collected, 0) AS total_collected,
                COALESCE(cg.completed_count, 0) AS completed_games,
                COALESCE(cs.achieved_at, 0) AS achieved_at,
                p.id AS stable_id
         FROM players p
         LEFT JOIN collection_stats cs ON cs.player_id = p.id
         LEFT JOIN completed_games cg ON cg.player_id = p.id
         WHERE p.leaderboard_visible = 1 AND COALESCE(cs.total_collected, 0) > 0
         ORDER BY total_collected DESC, completed_games DESC, achieved_at ASC, stable_id ASC
         LIMIT 3`,
      )
      .all() as Array<{
      display_name: string;
      total_collected: number;
      completed_games: number;
    }>;
    response.json({
      leaderboard: rows.map((row, index) => ({
        rank: index + 1,
        displayName: row.display_name,
        totalCollected: row.total_collected,
        completedGames: row.completed_games,
      })),
    });
  });

  app.post("/auth/logout", (request: Request, response: Response) => {
    const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
    if (sessionToken) {
      const activeGame = options.database
        .prepare(
          `SELECT gp.game_id
           FROM game_participants gp
           JOIN player_sessions s ON s.player_id = gp.player_id
           WHERE s.token_hash = ? AND s.revoked_at IS NULL AND gp.status = 'playing'`,
        )
        .get(hashToken(sessionToken));
      if (activeGame) {
        response.status(409).json({
          error: "請先暫停或退出遊戲，再登出。",
        });
        return;
      }
      options.database
        .prepare(
          "UPDATE player_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .run(now(), hashToken(sessionToken));
    }
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
        secureCookies ? "; Secure" : ""
      }`,
    );
    response.status(204).end();
  });

  app.post("/auth/device/forget", (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    const player = authenticatedPlayer(request);
    if (!player) {
      response.status(401).json({ error: "請先登入。" });
      return;
    }
    const activeGame = options.database
      .prepare(
        `SELECT game_id FROM game_participants
         WHERE player_id = ? AND status = 'playing'`,
      )
      .get(player.id);
    if (activeGame) {
      response.status(409).json({
        error: "請先暫停目前遊戲，再忘記此裝置。",
      });
      return;
    }

    const timestamp = now();
    const trustedDeviceToken = readCookie(
      request,
      TRUSTED_DEVICE_COOKIE_NAME,
    );
    const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
    beginWriteTransaction(options.database);
    try {
      options.database
        .prepare(
          `UPDATE player_sessions SET revoked_at = ?
           WHERE token_hash = ? AND player_id = ? AND revoked_at IS NULL`,
        )
        .run(timestamp, hashToken(sessionToken ?? ""), player.id);
      if (trustedDeviceToken) {
        options.database
          .prepare(
            `UPDATE player_trusted_devices SET revoked_at = ?
             WHERE token_hash = ? AND player_id = ? AND revoked_at IS NULL`,
          )
          .run(timestamp, hashToken(trustedDeviceToken), player.id);
      }
      options.database.exec("COMMIT");
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }

    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
        secureCookies ? "; Secure" : ""
      }`,
    );
    clearTrustedDeviceCookie(response, secureCookies);
    response.status(204).end();
  });

  const gameRouterOptions = {
    database: options.database,
    now,
    createId,
    getAdminActorId: getAuthenticatedAdminActorId,
  };
  app.use(
    "/games",
    createPlayerSessionMiddleware(options.database),
    (request, response, next) => {
      if (request.method === "POST" && request.path.endsWith("/location")) {
        locationRateLimit(request, response, next);
        return;
      }
      if (
        request.method === "POST" &&
        request.path.endsWith("/collect")
      ) {
        collectionRateLimit(request, response, next);
        return;
      }
      next();
    },
    createPlayerGameRouter(gameRouterOptions),
  );
  const requireAdminAccess: RequestHandler = async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (options.authorizeAdmin) {
      if (!(await options.authorizeAdmin(request))) {
        response.status(403).json({ error: "需要管理員權限。" });
        return;
      }
      next();
      return;
    }
    const admin = findAdminSession(request);
    if (!admin) {
      response.status(401).json({ error: "請先確認此裝置的管理員 Email 並登入。" });
      return;
    }
    const isAuditorRead =
      admin.role === "auditor" &&
      request.method === "GET" &&
      (request.path === "/auth/me" ||
        request.path === "/games/anomalies" ||
        request.path === "/audit-logs");
    if (admin.role === "auditor" && !isAuditorRead) {
      response.status(403).json({ error: "此管理員角色無權執行此操作。" });
      return;
    }
    next();
  };
  const requireOwner: RequestHandler = (request, response, next) => {
    const admin = findAdminSession(request);
    if (!admin || admin.role !== "owner") {
      response.status(403).json({ error: "需要系統管理員權限。" });
      return;
    }
    next();
  };
  const requireAuditRead: RequestHandler = async (request, response, next) => {
    if (options.authorizeAdmin) {
      if (!(await options.authorizeAdmin(request))) {
        response.status(403).json({ error: "需要管理員權限。" });
        return;
      }
      next();
      return;
    }
    const admin = findAdminSession(request);
    if (!admin || (admin.role !== "owner" && admin.role !== "auditor")) {
      response.status(403).json({ error: "此管理員角色無權查閱稽核紀錄。" });
      return;
    }
    next();
  };
  const administratorsRouter = express.Router();
  administratorsRouter.use(requireOwner);
  administratorsRouter.get("/", (_request, response) => {
    const administrators = options.database
      .prepare(
        `SELECT id, email, role, active, created_by, created_at, disabled_at
         FROM administrators ORDER BY created_at, id`,
      )
      .all() as Array<{
      id: string;
      email: string;
      role: string;
      active: number;
      created_by: string | null;
      created_at: number;
      disabled_at: number | null;
    }>;
    response.json({
      administrators: administrators.map((admin) => ({
        ...admin,
        active: admin.active === 1,
      })),
    });
  });
  administratorsRouter.post("/", (request, response) => {
    if (
      !isRecord(request.body) ||
      typeof request.body.email !== "string" ||
      typeof request.body.role !== "string"
    ) {
      response.status(400).json({ error: "請提供有效的管理員 Email 與角色。" });
      return;
    }
    const email = normalizeEmail(request.body.email);
    const role = request.body.role;
    if (
      !validator.isEmail(email) ||
      !["owner", "admin", "auditor"].includes(role)
    ) {
      response.status(400).json({ error: "管理員 Email 或角色無效。" });
      return;
    }
    const actorId = getAuthenticatedAdminActorId(request);
    if (!actorId) {
      response.status(503).json({ error: "目前無法取得管理員識別資訊。" });
      return;
    }
    const id = createId();
    try {
      options.database
        .prepare(
          `INSERT INTO administrators (
            id, email, role, active, created_by, created_at
          ) VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(id, email, role, actorId, now());
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed: administrators.email")
      ) {
        response.status(409).json({ error: "此管理員 Email 已存在。" });
        return;
      }
      throw error;
    }
    response.status(201).json({ id, role, active: true });
  });
  administratorsRouter.patch("/:adminId", (request, response) => {
    const adminId = request.params.adminId;
    if (typeof adminId !== "string" || !isRecord(request.body)) {
      response.status(400).json({ error: "管理員識別碼或變更資料無效。" });
      return;
    }
    const updates: string[] = [];
    const values: Array<string | number | null> = [];
    if (Object.hasOwn(request.body, "role")) {
      if (
        typeof request.body.role !== "string" ||
        !["owner", "admin", "auditor"].includes(request.body.role)
      ) {
        response.status(400).json({ error: "管理員角色無效。" });
        return;
      }
      updates.push("role = ?");
      values.push(request.body.role);
    }
    if (Object.hasOwn(request.body, "active")) {
      if (typeof request.body.active !== "boolean") {
        response.status(400).json({ error: "管理員啟用狀態無效。" });
        return;
      }
      updates.push("active = ?", "disabled_at = ?");
      values.push(request.body.active ? 1 : 0, request.body.active ? null : now());
    }
    if (updates.length === 0) {
      response.status(400).json({ error: "請提供角色或啟用狀態變更。" });
      return;
    }
    values.push(adminId);
    beginWriteTransaction(options.database);
    try {
      const target = options.database
        .prepare("SELECT id, role, active FROM administrators WHERE id = ?")
        .get(adminId) as
        | { id: string; role: string; active: number }
        | undefined;
      if (!target) {
        options.database.exec("ROLLBACK");
        response.status(404).json({ error: "找不到管理員。" });
        return;
      }
      const losesLastOwner =
        target.active === 1 &&
        target.role === "owner" &&
        (request.body.active === false ||
          (typeof request.body.role === "string" &&
            request.body.role !== "owner"));
      if (
        losesLastOwner &&
        Number(
          (
            options.database
              .prepare(
                "SELECT COUNT(*) AS count FROM administrators WHERE role = 'owner' AND active = 1",
              )
              .get() as { count: number }
          ).count,
        ) <= 1
      ) {
        options.database.exec("ROLLBACK");
        response.status(409).json({ error: "至少必須保留一位啟用中的系統管理員。" });
        return;
      }
      const result = options.database
        .prepare(`UPDATE administrators SET ${updates.join(", ")} WHERE id = ?`)
        .run(...values);
      if (Number(result.changes) !== 1) {
        options.database.exec("ROLLBACK");
        response.status(404).json({ error: "找不到管理員。" });
        return;
      }
      if (request.body.active === false) {
        options.database
          .prepare(
            `UPDATE admin_sessions SET revoked_at = ?
             WHERE admin_id = ? AND revoked_at IS NULL`,
          )
          .run(now(), adminId);
      }
      options.database.exec("COMMIT");
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
    response.json({ id: adminId, updated: true });
  });
  administratorsRouter.delete("/:adminId", (request, response) => {
    const adminId = request.params.adminId;
    if (typeof adminId !== "string") {
      response.status(400).json({ error: "管理員識別碼無效。" });
      return;
    }
    beginWriteTransaction(options.database);
    try {
      const target = options.database
        .prepare("SELECT role, active FROM administrators WHERE id = ?")
        .get(adminId) as { role: string; active: number } | undefined;
      if (!target) {
        options.database.exec("ROLLBACK");
        response.status(404).json({ error: "找不到管理員。" });
        return;
      }
      if (
        target.active === 1 &&
        target.role === "owner" &&
        Number(
          (
            options.database
              .prepare(
                "SELECT COUNT(*) AS count FROM administrators WHERE role = 'owner' AND active = 1",
              )
              .get() as { count: number }
          ).count,
        ) <= 1
      ) {
        options.database.exec("ROLLBACK");
        response.status(409).json({ error: "至少必須保留一位啟用中的系統管理員。" });
        return;
      }
      options.database
        .prepare(
          `UPDATE administrators SET active = 0, disabled_at = ?
           WHERE id = ?`,
        )
        .run(now(), adminId);
      options.database
        .prepare(
          `UPDATE admin_sessions SET revoked_at = ?
           WHERE admin_id = ? AND revoked_at IS NULL`,
        )
        .run(now(), adminId);
      options.database.exec("COMMIT");
    } catch (error) {
      options.database.exec("ROLLBACK");
      throw error;
    }
    response.json({ id: adminId, revoked: true });
  });

  const auditLogRouter = express.Router();
  auditLogRouter.use(requireAuditRead);
  auditLogRouter.get("/", (_request, response) => {
    const rows = options.database
      .prepare(
        `SELECT id, actor_id, action, target_type, target_id,
                result, summary_json, created_at
         FROM admin_audit_log
         WHERE created_at >= ?
         ORDER BY created_at DESC, id DESC
         LIMIT 500`,
      )
      .all(now() - ADMIN_AUDIT_RETENTION_MS) as Array<{
      id: string;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string | null;
      result: string;
      summary_json: string;
      created_at: number;
    }>;
    response.json({
      auditLogs: rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        result: row.result,
        summary: JSON.parse(row.summary_json) as unknown,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      retentionDays: 90,
    });
  });
  app.use("/admin", auditAdminRequest, requireAdminAccess);
  app.get("/admin/auth/me", (request, response) => {
    const admin = findAdminSession(request);
    if (!admin) {
      response.status(401).json({ error: "請先確認此裝置的管理員 Email 並登入。" });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ admin: { role: admin.role } });
  });
  app.use("/admin/administrators", administratorsRouter);
  app.use("/admin/audit-logs", auditLogRouter);
  app.use(
    "/admin/games",
    createAdminGameRouter(gameRouterOptions),
  );

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    if (error instanceof EmailDeliveryError) {
      const cause = error.cause;
      if (typeof cause === "object" && cause !== null) {
        const smtpFailure = cause as {
          code?: unknown;
          command?: unknown;
          responseCode?: unknown;
        };
        console.error("Magic Link SMTP delivery failed", {
          code: typeof smtpFailure.code === "string" ? smtpFailure.code : undefined,
          command:
            typeof smtpFailure.command === "string"
              ? smtpFailure.command
              : undefined,
          responseCode:
            typeof smtpFailure.responseCode === "number"
              ? smtpFailure.responseCode
              : undefined,
        });
      } else {
        console.error("Magic Link SMTP delivery failed without error details");
      }
      response.status(503).json({ error: "目前無法寄送登入連結，請稍後再試。" });
      return;
    }
    next(error);
  };
  app.use(errorHandler);

  return app;
}

function randomUUID(): string {
  return randomBytes(16).toString("hex");
}
