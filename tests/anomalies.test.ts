import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";

class TestMagicLinkSender implements MagicLinkSender {
  readonly tokens: string[] = [];

  async send(_email: string, url: string): Promise<void> {
    const token = new URL(url).searchParams.get("token");
    if (!token) {
      throw new Error("Expected token in magic link URL");
    }
    this.tokens.push(token);
  }
}

describe("異常訊號與雙人審查", () => {
  let database: DatabaseSync;
  let mailer: TestMagicLinkSender;
  let server: Server;
  let baseUrl: string;
  let now: number;
  let nextId: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    mailer = new TestMagicLinkSender();
    now = Date.UTC(2026, 0, 1, 3);
    nextId = 0;
    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      createToken: () => `anomaly-token-${mailer.tokens.length + 1}`,
      createId: () => `anomaly-id-${++nextId}`,
      authorizeAdmin: (request) => request.header("x-test-admin") === "yes",
      getAdminActorId: (request) => request.header("x-test-admin-id") ?? undefined,
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

  async function adminRequest(
    path: string,
    method: string,
    body?: Record<string, unknown>,
    actorId = "admin-1",
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-admin": "yes",
        "x-test-admin-id": actorId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createPlayer(email: string): Promise<string> {
    const link = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(link.status).toBe(202);
    const verified = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: mailer.tokens[mailer.tokens.length - 1] }),
    });
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected an authenticated player");
    }
    return cookie;
  }

  async function createGame(cookie: string): Promise<{
    gameId: string;
    treasureId: string;
  }> {
    const createResponse = await adminRequest("/admin/games", "POST", {
      name: "異常測試場",
      startsAt: "2026-01-01T10:00:00+08:00",
      endsAt: "2026-01-01T22:00:00+08:00",
      timezone: "Asia/Taipei",
      mapCenter: { latitude: 25, longitude: 121 },
    });
    const { game } = await createResponse.json();
    const treasureResponse = await adminRequest(
      `/admin/games/${game.id}/treasures`,
      "POST",
      {
        title: "測試寶藏",
        latitude: 25,
        longitude: 121,
        fuzzyLatitude: 25.001,
        fuzzyLongitude: 121.001,
        fuzzyRadiusMeters: 100,
      },
    );
    const { treasure } = await treasureResponse.json();
    expect((await adminRequest(`/admin/games/${game.id}/publish`, "POST")).status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/games/${game.id}/join`, {
          method: "POST",
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    return { gameId: game.id as string, treasureId: treasure.id as string };
  }

  async function reportLocation(
    gameId: string,
    cookie: string,
    latitude: number,
    longitude: number,
    accuracy: number,
    timestamp: number,
  ): Promise<Response> {
    return fetch(`${baseUrl}/games/${gameId}/location`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ latitude, longitude, accuracy, timestamp }),
    });
  }

  async function collect(
    gameId: string,
    treasureId: string,
    cookie: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}/games/${gameId}/treasures/${treasureId}/collect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        latitude: 25,
        longitude: 121,
        accuracy: 5,
        timestamp: now,
      }),
    });
  }

  it("records rapid long-distance movement and speed signals without changing scores", async () => {
    const cookie = await createPlayer("traveler@example.com");
    const { gameId, treasureId } = await createGame(cookie);
    expect((await collect(gameId, treasureId, cookie)).status).toBe(200);
    expect((await reportLocation(gameId, cookie, 25, 121, 5, now)).status).toBe(200);
    now += 60_000;
    expect(
      (await reportLocation(gameId, cookie, 25.01, 121, 5, now)).status,
    ).toBe(200);

    const signals = database
      .prepare(
        "SELECT signal_type, details_json FROM anomaly_events ORDER BY signal_type",
      )
      .all() as Array<{ signal_type: string; details_json: string }>;

    expect(signals.map(({ signal_type }) => signal_type)).toEqual([
      "location_jump",
      "speed",
    ]);
    expect(JSON.parse(signals[1].details_json)).toMatchObject({
      elapsedMilliseconds: 60_000,
      accuracyAdjustedDistanceMeters: expect.any(Number),
      speedKilometersPerHour: expect.any(Number),
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 1 });
    expect(
      await (
        await fetch(`${baseUrl}/leaderboard`)
      ).json(),
    ).toMatchObject({
      leaderboard: [
        { totalCollected: 1, completedGames: 1 },
      ],
    });
    expect(
      (
        await fetch(`${baseUrl}/games/${gameId}/pause`, {
          method: "POST",
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    expect(
      database
        .prepare(
          "SELECT expires_at FROM location_samples WHERE game_id = ? AND player_id = (SELECT id FROM players WHERE email = ?)",
        )
        .get(gameId, "traveler@example.com"),
    ).toEqual({ expires_at: now + 24 * 60 * 60 * 1000 });
  });

  it("does not signal GPS drift when accuracy-adjusted speed is below the threshold", async () => {
    const cookie = await createPlayer("drift@example.com");
    const { gameId } = await createGame(cookie);
    await reportLocation(gameId, cookie, 25, 121, 25, now);
    now += 60_000;
    await reportLocation(gameId, cookie, 25.0001, 121, 25, now);

    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM anomaly_events WHERE signal_type = 'speed'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("flags ten attempts within five minutes once while keeping collection idempotent", async () => {
    const cookie = await createPlayer("retry@example.com");
    const { gameId, treasureId } = await createGame(cookie);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await collect(gameId, treasureId, cookie);
      expect(response.status).toBe(200);
      now += 20_000;
    }

    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM collected_treasures")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM anomaly_events WHERE signal_type = 'repeated_collection_attempts'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("requires two distinct administrators with matching decisions to close a review and audits both", async () => {
    const cookie = await createPlayer("review@example.com");
    const { gameId } = await createGame(cookie);
    await reportLocation(gameId, cookie, 25, 121, 5, now);
    now += 60_000;
    await reportLocation(gameId, cookie, 25.01, 121, 5, now);

    const listResponse = await adminRequest("/admin/games/anomalies", "GET");
    const list = await listResponse.json();
    const anomalyId = list.anomalies[0].id as string;
    expect(list.anomalies[0].evidence.locationSamples).toHaveLength(2);
    const noActorResponse = await fetch(
      `${baseUrl}/admin/games/anomalies/${anomalyId}/reviews`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-admin": "yes",
        },
        body: JSON.stringify({ decision: "confirmed" }),
      },
    );
    const firstReview = await adminRequest(
      `/admin/games/anomalies/${anomalyId}/reviews`,
      "POST",
      { decision: "confirmed", notes: "需人工查核" },
      "admin-1",
    );
    const selfConfirmation = await adminRequest(
      `/admin/games/anomalies/${anomalyId}/reviews`,
      "POST",
      { decision: "confirmed", notes: "重複確認" },
      "admin-1",
    );
    const conflictingConfirmation = await adminRequest(
      `/admin/games/anomalies/${anomalyId}/reviews`,
      "POST",
      { decision: "dismissed", notes: "不同結論" },
      "admin-2",
    );
    const secondReview = await adminRequest(
      `/admin/games/anomalies/${anomalyId}/reviews`,
      "POST",
      { decision: "confirmed", notes: "確認訊號" },
      "admin-2",
    );
    const updatedListResponse = await adminRequest("/admin/games/anomalies", "GET");
    const updatedList = await updatedListResponse.json();

    expect(firstReview.status).toBe(202);
    expect(noActorResponse.status).toBe(503);
    expect(selfConfirmation.status).toBe(409);
    expect(conflictingConfirmation.status).toBe(409);
    expect(secondReview.status).toBe(200);
    expect(updatedList.anomalies.find((item: { id: string }) => item.id === anomalyId))
      .toMatchObject({ status: "reviewed", decision: "confirmed" });
    expect(
      database
        .prepare(
          "SELECT COUNT(DISTINCT actor_id) AS count FROM anomaly_audit_log WHERE anomaly_id = ?",
        )
        .get(anomalyId),
    ).toEqual({ count: 2 });
  });

  it("requires two distinct administrator approvals before resetting progress and totals", async () => {
    const cookie = await createPlayer("reset@example.com");
    const playerId = (
      database
        .prepare("SELECT id FROM players WHERE email = ?")
        .get("reset@example.com") as { id: string }
    ).id;
    const { gameId, treasureId } = await createGame(cookie);
    expect((await collect(gameId, treasureId, cookie)).status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
      ).headers.get("cache-control"),
    ).toBe("no-store");

    const resetResponse = await adminRequest(
      `/admin/games/${gameId}/players/${playerId}/progress-reset`,
      "POST",
      { reason: "使用者確認需重置" },
      "admin-1",
    );
    const reset = await resetResponse.json();
    const selfConfirm = await adminRequest(
      `/admin/games/progress-resets/${reset.resetId}/confirm`,
      "POST",
      {},
      "admin-1",
    );
    const secondConfirm = await adminRequest(
      `/admin/games/progress-resets/${reset.resetId}/confirm`,
      "POST",
      {},
      "admin-2",
    );

    expect(resetResponse.status).toBe(202);
    expect(selfConfirm.status).toBe(409);
    expect(secondConfirm.status).toBe(200);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 0 });
    expect(
      (
        await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
      ).status,
    ).toBe(200);
    expect(
      await (
        await fetch(`${baseUrl}/auth/me`, { headers: { cookie } })
      ).json(),
    ).toMatchObject({ player: { totalCollectedSoFar: 0 } });
    expect(
      JSON.parse(
        (
          database
            .prepare(
              "SELECT progress_json FROM game_participants WHERE game_id = ? AND player_id = ?",
            )
            .get(gameId, playerId) as { progress_json: string }
        ).progress_json,
      ),
    ).toMatchObject({
      collectedTreasureIds: [],
      collectedCount: 0,
      targetTreasureCount: 1,
      completed: false,
    });

    const restoredResponse = await adminRequest(
      `/admin/games/progress-resets/${reset.resetId}/restore`,
      "POST",
      {},
      "admin-3",
    );
    const restored = await restoredResponse.json();
    const duplicateRestore = await adminRequest(
      `/admin/games/progress-resets/${reset.resetId}/restore`,
      "POST",
      {},
      "admin-4",
    );

    expect(restoredResponse.status).toBe(200);
    expect(restored).toMatchObject({
      status: "restored",
      progress: {
        collectedTreasureIds: [treasureId],
        collectedCount: 1,
        targetTreasureCount: 1,
        completed: true,
      },
      totalCollectedSoFar: 1,
    });
    expect(duplicateRestore.status).toBe(409);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 1 });
  });

  it("does not overwrite newer collections when restoring an old progress reset", async () => {
    const cookie = await createPlayer("restore-conflict@example.com");
    const playerId = (
      database
        .prepare("SELECT id FROM players WHERE email = ?")
        .get("restore-conflict@example.com") as { id: string }
    ).id;
    const { gameId, treasureId } = await createGame(cookie);
    expect((await collect(gameId, treasureId, cookie)).status).toBe(200);
    const resetResponse = await adminRequest(
      `/admin/games/${gameId}/players/${playerId}/progress-reset`,
      "POST",
      { reason: "測試復原衝突" },
      "admin-1",
    );
    const { resetId } = await resetResponse.json();
    expect(
      (
        await adminRequest(
          `/admin/games/progress-resets/${resetId}/confirm`,
          "POST",
          {},
          "admin-2",
        )
      ).status,
    ).toBe(200);
    expect((await collect(gameId, treasureId, cookie)).status).toBe(200);

    const restoreResponse = await adminRequest(
      `/admin/games/progress-resets/${resetId}/restore`,
      "POST",
      {},
      "admin-3",
    );

    expect(restoreResponse.status).toBe(409);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 1 });
  });
});
