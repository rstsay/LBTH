import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { completeMagicLinkLogin } from "./helpers/auth-flow.js";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";
import { runDataRetentionCleanup } from "../src/retention.ts";

class TestMagicLinkSender implements MagicLinkSender {
  readonly tokens: string[] = [];
  readonly requestIds = new Map<string, string>();

  async send(_email: string, url: string): Promise<void> {
    const token = new URL(url).searchParams.get("token");
    if (!token) {
      throw new Error("Expected token in magic link URL");
    }
    this.tokens.push(token);
    this.requestIds.set(token, new URL(url).searchParams.get("requestId")!);
  }
}

describe("資料保留、永久刪除與玩家帳號刪除", () => {
  let database: DatabaseSync;
  let mailer: TestMagicLinkSender;
  let server: Server;
  let baseUrl: string;
  let now: number;
  let nextId: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    mailer = new TestMagicLinkSender();
    now = Date.UTC(2026, 9, 1);
    nextId = 0;
    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      createToken: () => `retention-token-${mailer.tokens.length + 1}`,
      createId: () => `retention-id-${++nextId}`,
      authorizeAdmin: () => true,
      getAdminActorId: () => "retention-admin",
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not bind to a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    database.close();
  });

  async function createPlayer(email: string): Promise<{
    playerId: string;
    cookie: string;
  }> {
    const requestResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(requestResponse.status).toBe(202);
    const token = mailer.tokens.at(-1);
    if (!token) {
      throw new Error("Expected a player Magic Link");
    }
    const loginResponse = await completeMagicLinkLogin(baseUrl, token, requestResponse.headers.get("X-Auth-Request-Token")!, mailer.requestIds.get(token)!);
    expect(loginResponse.status).toBe(200);
    const result = await loginResponse.json();
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a player session cookie");
    }
    return { playerId: result.player.id as string, cookie };
  }

  function seedGame(
    gameId: string,
    status: "draft" | "published" | "paused" | "ended",
    endsAt: number,
    endedAt: number | null,
  ): void {
    database
      .prepare(
        `INSERT INTO games (
          id, name, description, starts_at, ends_at, timezone,
          map_center_latitude, map_center_longitude, status, ended_at,
          archive_restored_at, created_at, updated_at
        ) VALUES (?, ?, '', ?, ?, 'Asia/Taipei', 25, 121, ?, ?, NULL, ?, ?)`,
      )
      .run(gameId, gameId, endsAt - 60_000, endsAt, status, endedAt, now, now);
  }

  it("cleans location, closed-game events, ended game content, expired retained events, and old audit rows", () => {
    const playerId = "retention-player";
    database
      .prepare(
        `INSERT INTO players (
          id, email, anonymous_code, email_verified_at, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(playerId, "retention@example.com", "玩家-RET", now, now);
    const closedAt = now - 7 * 24 * 60 * 60 * 1000;
    seedGame("expired-game", "ended", closedAt, closedAt);
    seedGame("not-yet-expired-game", "ended", now - 7 * 24 * 60 * 60 * 1000 + 1, now - 7 * 24 * 60 * 60 * 1000 + 1);
    database
      .prepare(
        `INSERT INTO game_participants (
          game_id, player_id, status, progress_json, created_at, updated_at
        ) VALUES (?, ?, 'exited', '{}', ?, ?)`,
      )
      .run("expired-game", playerId, now, now);
    database
      .prepare(
        `INSERT INTO treasures (
          id, game_id, title, latitude, longitude, fuzzy_latitude,
          fuzzy_longitude, fuzzy_radius_meters, enabled, sort_order,
          created_at, updated_at
        ) VALUES ('expired-treasure', 'expired-game', '寶藏', 25, 121, 25, 121, 20, 1, 0, ?, ?)`,
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO collected_treasures (
          game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
        ) VALUES ('expired-game', ?, 'expired-treasure', ?, 3, 5)`,
      )
      .run(playerId, closedAt + 1);
    database
      .prepare(
        `INSERT INTO anomaly_events (
          id, game_id, player_id, signal_type, details_json, detected_at, dedupe_key
        ) VALUES ('expired-anomaly', 'expired-game', ?, 'speed', '{}', ?, 'expired-key')`,
      )
      .run(playerId, closedAt + 2);
    database
      .prepare(
        `INSERT INTO location_samples (
          id, game_id, player_id, latitude, longitude, accuracy,
          measured_at, expires_at
        ) VALUES ('expired-location', 'expired-game', ?, 25.033, 121.5654, 5, ?, ?)`,
      )
      .run(playerId, now - 24 * 60 * 60 * 1000, now);
    database
      .prepare(
        `INSERT INTO admin_audit_log (
          id, actor_id, action, target_type, target_id, result, summary_json, created_at
        ) VALUES ('old-audit', 'admin', 'test', 'game', 'expired-game', 'success', '{}', ?)`,
      )
      .run(now - 90 * 24 * 60 * 60 * 1000 - 1);
    database
      .prepare(
        `INSERT INTO admin_audit_log (
          id, actor_id, action, target_type, target_id, result, summary_json, created_at
        ) VALUES ('recent-audit', 'admin', 'test', 'game', 'active-game', 'success', '{}', ?)`,
      )
      .run(now - 90 * 24 * 60 * 60 * 1000);

    const result = runDataRetentionCleanup(database, now);
    const retained = database
      .prepare("SELECT event_type, occurred_at, expires_at, details_json FROM retained_game_events")
      .all() as Array<{
      event_type: string;
      occurred_at: number;
      expires_at: number;
      details_json: string;
    }>;
    const auditActions = database
      .prepare("SELECT action FROM data_retention_audit ORDER BY action")
      .all() as Array<{ action: string }>;

    expect(result).toMatchObject({
      locationSamplesDeleted: 1,
      gamesDeleted: 1,
      auditRowsDeleted: 1,
      retainedEventsDeleted: 0,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM games WHERE id = 'expired-game'").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM games WHERE id = 'not-yet-expired-game'").get(),
    ).toEqual({ count: 1 });
    expect(retained).toHaveLength(2);
    expect(retained.map(({ event_type }) => event_type).sort()).toEqual([
      "anomaly",
      "collection",
    ]);
    expect(retained.every(({ expires_at }) => expires_at === closedAt + 30 * 24 * 60 * 60 * 1000)).toBe(
      true,
    );
    expect(JSON.stringify(retained)).not.toContain(playerId);
    expect(JSON.stringify(retained)).not.toContain("25.033");
    expect(JSON.stringify(retained)).not.toContain("121.5654");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM admin_audit_log").get(),
    ).toEqual({ count: 1 });
    expect(() =>
      database
        .prepare("DELETE FROM admin_audit_log WHERE id = 'recent-audit'")
        .run(),
    ).toThrow();
    expect(auditActions.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "admin_audit_records_expired",
        "game_content_purged",
        "location_samples_expired",
      ]),
    );
  });

  it("permanently deletes ended games while preserving only anonymized events through day 30", async () => {
    const player = await createPlayer("game-delete@example.com");
    const closedAt = now - 6 * 24 * 60 * 60 * 1000;
    seedGame("manual-delete-game", "ended", closedAt, closedAt);
    database
      .prepare(
        `INSERT INTO game_participants (
          game_id, player_id, status, progress_json, created_at, updated_at
        ) VALUES ('manual-delete-game', ?, 'exited', '{}', ?, ?)`,
      )
      .run(player.playerId, now, now);
    database
      .prepare(
        `INSERT INTO treasures (
          id, game_id, title, latitude, longitude, fuzzy_latitude,
          fuzzy_longitude, fuzzy_radius_meters, enabled, sort_order,
          created_at, updated_at
        ) VALUES ('manual-delete-treasure', 'manual-delete-game', '寶藏', 25, 121, 25, 121, 20, 1, 0, ?, ?)`,
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO collected_treasures (
          game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
        ) VALUES ('manual-delete-game', ?, 'manual-delete-treasure', ?, 3, 5)`,
      )
      .run(player.playerId, closedAt + 1);

    const tooEarlyResponse = await fetch(
      `${baseUrl}/admin/games/manual-delete-game`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-test-admin": "yes",
        },
        body: JSON.stringify({ confirmPermanentDeletion: true }),
      },
    );
    now = closedAt + 7 * 24 * 60 * 60 * 1000;
    const deleteResponse = await fetch(
      `${baseUrl}/admin/games/manual-delete-game`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-test-admin": "yes",
        },
        body: JSON.stringify({ confirmPermanentDeletion: true }),
      },
    );
    const retainedCount = database
      .prepare("SELECT COUNT(*) AS count FROM retained_game_events")
      .get();

    expect(tooEarlyResponse.status).toBe(409);
    expect(deleteResponse.status).toBe(204);
    expect(retainedCount).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM games").get(),
    ).toEqual({ count: 0 });

    now = closedAt + 30 * 24 * 60 * 60 * 1000;
    const cleanup = runDataRetentionCleanup(database, now);
    const expiryAudit = database
      .prepare(
        "SELECT COUNT(*) AS count FROM data_retention_audit WHERE action = 'retained_events_expired'",
      )
      .get();

    expect(cleanup.retainedEventsDeleted).toBe(1);
    expect(expiryAudit).toEqual({ count: 1 });
  });

  it("deletes account identifiers and credentials, removes leaderboard data, and retains anonymized events", async () => {
    const player = await createPlayer("delete-account@example.com");
    seedGame("account-game", "ended", now - 2 * 24 * 60 * 60 * 1000, now - 2 * 24 * 60 * 60 * 1000);
    database
      .prepare(
        `INSERT INTO game_participants (
          game_id, player_id, status, progress_json, created_at, updated_at
        ) VALUES ('account-game', ?, 'exited', '{}', ?, ?)`,
      )
      .run(player.playerId, now, now);
    database
      .prepare(
        `INSERT INTO treasures (
          id, game_id, title, latitude, longitude, fuzzy_latitude,
          fuzzy_longitude, fuzzy_radius_meters, enabled, sort_order,
          created_at, updated_at
        ) VALUES ('account-treasure', 'account-game', '寶藏', 25, 121, 25, 121, 20, 1, 0, ?, ?)`,
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO collected_treasures (
          game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
        ) VALUES ('account-game', ?, 'account-treasure', ?, 3, 5)`,
      )
      .run(player.playerId, now - 1);

    const missingConfirmation = await fetch(`${baseUrl}/auth/me`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: player.cookie,
      },
    });
    const deleteResponse = await fetch(`${baseUrl}/auth/me`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: player.cookie,
      },
      body: JSON.stringify({ confirmPermanentDeletion: true }),
    });
    const meResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: player.cookie },
    });
    const leaderboardResponse = await fetch(`${baseUrl}/leaderboard`);
    const leaderboard = await leaderboardResponse.json();
    const retained = database
      .prepare("SELECT details_json FROM retained_game_events")
      .all();
    const retentionAudit = database
      .prepare(
        "SELECT action, subject_hash FROM data_retention_audit ORDER BY created_at",
      )
      .all() as Array<{ action: string; subject_hash: string }>;

    expect(missingConfirmation.status).toBe(400);
    expect(deleteResponse.status).toBe(204);
    expect(meResponse.status).toBe(401);
    expect(leaderboard.leaderboard).toEqual([]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM players").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM player_sessions WHERE revoked_at IS NULL").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM magic_links WHERE email = ?").get(
        "delete-account@example.com",
      ),
    ).toEqual({ count: 0 });
    expect(retained).toHaveLength(1);
    expect(JSON.stringify(retained)).not.toContain(player.playerId);
    expect(JSON.stringify(retained)).not.toContain("delete-account@example.com");
    expect(retentionAudit).toMatchObject([
      { action: "player_account_deleted" },
    ]);
    expect(retentionAudit[0]?.subject_hash).toBe(
      createHash("sha256").update(player.playerId).digest("hex"),
    );
    expect(JSON.stringify(retentionAudit)).not.toContain("delete-account@example.com");
  });

  it("permits explicit account deletion while playing and removes the active session", async () => {
    const player = await createPlayer("playing-account@example.com");
    seedGame("playing-game", "published", now + 60_000, null);
    database
      .prepare(
        `INSERT INTO game_participants (
          game_id, player_id, status, progress_json, created_at, updated_at
        ) VALUES ('playing-game', ?, 'playing', '{}', ?, ?)`,
      )
      .run(player.playerId, now, now);

    const response = await fetch(`${baseUrl}/auth/me`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        cookie: player.cookie,
      },
      body: JSON.stringify({ confirmPermanentDeletion: true }),
    });

    expect(response.status).toBe(204);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM players").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM game_participants").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM player_sessions WHERE revoked_at IS NULL")
        .get(),
    ).toEqual({ count: 0 });
  });
});
