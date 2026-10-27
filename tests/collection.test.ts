import { DatabaseSync } from "node:sqlite";
import { completeMagicLinkLogin } from "./helpers/auth-flow.js";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";
import { COLLECTION_THRESHOLD_METERS } from "../web/geo.js";

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

describe("玩家位置與伺服器搜集驗證", () => {
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
      createToken: () => `collection-token-${mailer.tokens.length + 1}`,
      createId: () => `collection-id-${++nextId}`,
      authorizeAdmin: (request) => request.header("x-test-admin") === "yes",
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
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-admin": "yes",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createActiveGame(includeAdditionalTreasure = false): Promise<{
    gameId: string;
    treasureId: string;
    cookie: string;
  }> {
    const gameResponse = await adminRequest("/admin/games", "POST", {
      name: "定位測試場",
      startsAt: "2026-01-01T10:00:00+08:00",
      endsAt: "2026-01-01T12:00:00+08:00",
      timezone: "Asia/Taipei",
      mapCenter: { latitude: 25, longitude: 121 },
    });
    const { game } = await gameResponse.json();
    const treasureResponse = await adminRequest(`/admin/games/${game.id}/treasures`, "POST", {
      title: "測試寶藏",
      latitude: 25,
      longitude: 121,
      fuzzyLatitude: 25.01,
      fuzzyLongitude: 121.01,
      fuzzyRadiusMeters: 100,
      enabled: true,
    });
    const { treasure } = await treasureResponse.json();
    if (includeAdditionalTreasure) {
      const secondTreasureResponse = await adminRequest(
        `/admin/games/${game.id}/treasures`,
        "POST",
        {
          title: "另一個測試寶藏",
          latitude: 25.02,
          longitude: 121.02,
          fuzzyLatitude: 25.03,
          fuzzyLongitude: 121.03,
          fuzzyRadiusMeters: 100,
          enabled: true,
        },
      );
      expect(secondTreasureResponse.status).toBe(201);
    }
    expect((await adminRequest(`/admin/games/${game.id}/publish`, "POST")).status).toBe(200);

    const linkResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "gps-player@example.com" }),
    });
    expect(linkResponse.status).toBe(202);
    const token = mailer.tokens[mailer.tokens.length - 1]!;
    const verifyResponse = await completeMagicLinkLogin(baseUrl, token, linkResponse.headers.get("X-Auth-Request-Token")!, mailer.requestIds.get(token)!);
    expect(verifyResponse.status).toBe(200);
    const cookie = verifyResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected an authenticated player session");
    }
    const joinResponse = await fetch(`${baseUrl}/games/${game.id}/join`, {
      method: "POST",
      headers: { cookie },
    });
    expect(joinResponse.status).toBe(200);
    return { gameId: game.id as string, treasureId: treasure.id as string, cookie };
  }

  async function collect(
    gameId: string,
    treasureId: string,
    cookie: string,
    location: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${baseUrl}/games/${gameId}/treasures/${treasureId}/collect`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(location),
    });
  }

  it("collects at or inside the fixed 20-metre threshold using the submitted real position", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    const oneDegree = 180 / Math.PI;
    const boundaryLatitude =
      25 + (COLLECTION_THRESHOLD_METERS / 6_371_000) * oneDegree;
    const response = await collect(gameId, treasureId, cookie, {
      latitude: boundaryLatitude,
      longitude: 121,
      accuracy: 50,
      timestamp: now,
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      collected: true,
      treasureId,
      distanceMeters: expect.any(Number),
      totalCollected: 1,
    });
    expect(result.distanceMeters).toBeLessThanOrEqual(COLLECTION_THRESHOLD_METERS);
    expect(
      database
        .prepare("PRAGMA table_info(collected_treasures)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toEqual(expect.arrayContaining(["latitude", "longitude"]));
  });

  it("persists authoritative progress and returns the same progress when a collection is retried", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    database
      .prepare("UPDATE game_participants SET progress_json = ? WHERE game_id = ?")
      .run(
        JSON.stringify({
          collectedTreasureIds: ["stale-local-cache-id"],
          collectedCount: 99,
          completed: false,
        }),
        gameId,
      );
    const location = {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now,
    };
    const firstResponse = await collect(gameId, treasureId, cookie, location);
    const firstResult = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(firstResult).toMatchObject({
      collected: true,
      progress: {
        collectedTreasureIds: [treasureId],
        collectedCount: 1,
        targetTreasureCount: 1,
        completed: true,
      },
      totalCollected: 1,
      totalCollectedSoFar: 1,
    });
    expect(
      JSON.parse(
        (
          database
            .prepare(
              "SELECT progress_json FROM game_participants WHERE game_id = ?",
            )
            .get(gameId) as { progress_json: string }
        ).progress_json,
      ),
    ).toEqual(firstResult.progress);

    expect(
      (
        await fetch(`${baseUrl}/games/${gameId}/pause`, {
          method: "POST",
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie },
    })).status).toBe(204);

    const reloginRequest = await fetch(`${baseUrl}/auth/magic-links`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "gps-player@example.com" }),
        });
    expect(reloginRequest.status).toBe(202);
    const reloginToken = mailer.tokens[mailer.tokens.length - 1]!;
    const reloginResponse = await completeMagicLinkLogin(baseUrl, reloginToken, reloginRequest.headers.get("X-Auth-Request-Token")!, mailer.requestIds.get(reloginToken)!);
    const retryCookie = reloginResponse.headers.get("set-cookie")?.split(";")[0];
    if (reloginResponse.status !== 200 || !retryCookie) {
      throw new Error("Expected a replacement player session");
    }
    expect(
      (
        await fetch(`${baseUrl}/games/${gameId}/join`, {
          method: "POST",
          headers: { cookie: retryCookie },
        })
      ).status,
    ).toBe(200);
    const retryResponse = await collect(gameId, treasureId, retryCookie, location);
    const retryResult = await retryResponse.json();

    expect(retryResponse.status).toBe(200);
    expect(retryResult).toMatchObject({
      collected: true,
      alreadyCollected: true,
      distanceMeters: firstResult.distanceMeters,
      progress: firstResult.progress,
      totalCollected: 1,
      totalCollectedSoFar: 1,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 1 });
    expect(
      JSON.parse(
        (
          database
            .prepare(
              "SELECT progress_json FROM game_participants WHERE game_id = ?",
            )
            .get(gameId) as { progress_json: string }
        ).progress_json,
      ),
    ).toEqual(firstResult.progress);
  });

  it("rolls back the collection event if the authoritative progress update fails", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    database.exec(`
      CREATE TRIGGER reject_collection_progress
      BEFORE UPDATE OF progress_json ON game_participants
      BEGIN
        SELECT RAISE(ABORT, 'simulated progress write failure');
      END;
    `);

    const response = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now,
    });

    expect(response.status).toBe(500);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 0 });
    expect(
      JSON.parse(
        (
          database
            .prepare(
              "SELECT progress_json FROM game_participants WHERE game_id = ?",
            )
            .get(gameId) as { progress_json: string }
        ).progress_json,
      ),
    ).toEqual({});
  });

  it("keeps the per-game ledger while accumulating confirmed collections across games", async () => {
    const firstGame = await createActiveGame();
    const firstCollection = await collect(
      firstGame.gameId,
      firstGame.treasureId,
      firstGame.cookie,
      { latitude: 25, longitude: 121, accuracy: 5, timestamp: now },
    );
    expect(firstCollection.status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/games/${firstGame.gameId}/pause`, {
          method: "POST",
          headers: { cookie: firstGame.cookie },
        })
      ).status,
    ).toBe(200);
    expect((await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: firstGame.cookie },
    })).status).toBe(204);

    const secondGame = await createActiveGame();
    const secondCollection = await collect(
      secondGame.gameId,
      secondGame.treasureId,
      secondGame.cookie,
      { latitude: 25, longitude: 121, accuracy: 5, timestamp: now },
    );
    const secondResult = await secondCollection.json();

    expect(secondCollection.status).toBe(200);
    expect(secondResult).toMatchObject({
      progress: {
        collectedTreasureIds: [secondGame.treasureId],
        collectedCount: 1,
        targetTreasureCount: 1,
        completed: true,
      },
      totalCollected: 1,
      totalCollectedSoFar: 2,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM collected_treasures WHERE player_id = (SELECT player_id FROM game_participants WHERE game_id = ?)",
        )
        .get(secondGame.gameId),
    ).toEqual({ count: 2 });
    expect(
      JSON.parse(
        (
          database
            .prepare(
              "SELECT progress_json FROM game_participants WHERE game_id = ?",
            )
            .get(firstGame.gameId) as { progress_json: string }
        ).progress_json,
      ),
    ).toEqual({
      collectedTreasureIds: [firstGame.treasureId],
      collectedCount: 1,
      targetTreasureCount: 1,
      completed: true,
    });
  });

  it("recalculates completion when an administrator disables the last uncollected treasure", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame(true);
    const collectResponse = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now,
    });
    const collectResult = await collectResponse.json();

    expect(collectResponse.status).toBe(200);
    expect(collectResult.progress).toMatchObject({
      collectedCount: 1,
      targetTreasureCount: 2,
      completed: false,
    });

    const uncollected = database
      .prepare("SELECT id FROM treasures WHERE game_id = ? AND id != ?")
      .get(gameId, treasureId) as { id: string };
    const disableResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${uncollected.id}`,
      "PATCH",
      { enabled: false },
    );

    expect(disableResponse.status).toBe(200);
    expect(
      JSON.parse(
        (
          database
            .prepare(
              "SELECT progress_json FROM game_participants WHERE game_id = ?",
            )
            .get(gameId) as { progress_json: string }
        ).progress_json,
      ),
    ).toMatchObject({
      collectedTreasureIds: [treasureId],
      collectedCount: 1,
      targetTreasureCount: 1,
      completed: true,
    });
  });

  it("rejects positions just beyond 20 metres without widening the threshold for GPS accuracy", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    const latitude = ((COLLECTION_THRESHOLD_METERS + 0.1) / 6_371_000) * (180 / Math.PI);
    const response = await collect(gameId, treasureId, cookie, {
      latitude,
      longitude: 121,
      accuracy: 1,
      timestamp: now,
    });
    const result = await response.json();

    expect(response.status).toBe(422);
    expect(result).toMatchObject({
      error: "DISTANCE_TOO_FAR",
      thresholdMeters: COLLECTION_THRESHOLD_METERS,
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM collected_treasures")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("allows accuracy of exactly 50 metres and rejects worse accuracy with the specified message", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    const rejected = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 50.01,
      timestamp: now,
    });
    const result = await rejected.json();
    const allowed = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 50,
      timestamp: now,
    });

    expect(rejected.status).toBe(422);
    expect(result).toMatchObject({
      error: "GPS_ACCURACY_TOO_LOW",
      message: "定位精度不足，請移至空曠處或稍後再試",
    });
    expect(allowed.status).toBe(200);
  });

  it("rejects malformed, future-dated, or explicitly mocked location submissions", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    const invalidAccuracy = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: -1,
      timestamp: now,
    });
    const futureTimestamp = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now + 1,
    });
    const mockLocation = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now,
      source: "mock",
    });

    expect(invalidAccuracy.status).toBe(400);
    expect(futureTimestamp.status).toBe(400);
    expect(mockLocation.status).toBe(400);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM collected_treasures")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("reveals precise marker coordinates only while inside the treasure fuzzy zone", async () => {
    const { gameId, cookie } = await createActiveGame();
    const outsideResponse = await fetch(
      `${baseUrl}/games/${gameId}/location`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ latitude: 25, longitude: 121, accuracy: 5, timestamp: now }),
      },
    );
    const outsideText = await outsideResponse.text();
    now += 5_000;
    const lowAccuracyResponse = await fetch(`${baseUrl}/games/${gameId}/location`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        latitude: 25.01,
        longitude: 121.01,
        accuracy: 51,
        timestamp: now,
      }),
    });
    const lowAccuracyText = await lowAccuracyResponse.text();
    now += 5_000;
    const insideResponse = await fetch(
      `${baseUrl}/games/${gameId}/location`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          latitude: 25.01,
          longitude: 121.01,
          accuracy: 5,
          timestamp: now,
        }),
      },
    );
    const insideResult = await insideResponse.json();

    expect(outsideResponse.status).toBe(200);
    expect(outsideText).not.toContain('"latitude":25,"longitude":121');
    expect(lowAccuracyResponse.status).toBe(200);
    expect(lowAccuracyText).not.toContain('"latitude":25,"longitude":121');
    expect(insideResponse.status).toBe(200);
    expect(insideResult.treasures[0]).toMatchObject({
      preciseLocation: { latitude: 25, longitude: 121 },
      inFuzzyZone: true,
    });
  });

  it("rejects collection for a disabled treasure or non-playing game", async () => {
    const { gameId, treasureId, cookie } = await createActiveGame();
    const pauseGame = await adminRequest(`/admin/games/${gameId}/pause`, "POST");
    const pausedCollect = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now,
    });
    const resumeGame = await adminRequest(`/admin/games/${gameId}/resume`, "POST");
    const disableTreasure = await adminRequest(
      `/admin/games/${gameId}/treasures/${treasureId}`,
      "PATCH",
      { enabled: false },
    );
    const disabledCollect = await collect(gameId, treasureId, cookie, {
      latitude: 25,
      longitude: 121,
      accuracy: 5,
      timestamp: now,
    });

    expect(pauseGame.status).toBe(200);
    expect(pausedCollect.status).toBe(409);
    expect(resumeGame.status).toBe(200);
    expect(disableTreasure.status).toBe(200);
    expect(disabledCollect.status).toBe(409);
  });
});
