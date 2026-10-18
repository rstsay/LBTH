import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";
import { COLLECTION_THRESHOLD_METERS } from "../src/geo.ts";

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

describe("寶藏資料模型與草稿管理", () => {
  let database: DatabaseSync;
  let mailer: TestMagicLinkSender;
  let server: Server;
  let baseUrl: string;
  let now: number;
  let nextId: number;
  let nextToken: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    mailer = new TestMagicLinkSender();
    now = Date.UTC(2026, 0, 1, 3);
    nextId = 0;
    nextToken = 0;
    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      createToken: () => `treasure-test-token-${++nextToken}`,
      createId: () => `treasure-test-id-${++nextId}`,
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

  async function createDraft(): Promise<string> {
    const response = await adminRequest("/admin/games", "POST", {
      name: "寶藏測試場",
      description: "草稿地圖編輯",
      startsAt: "2026-01-01T10:00:00+08:00",
      endsAt: "2026-01-01T12:00:00+08:00",
      timezone: "Asia/Taipei",
      mapCenter: { latitude: 25.033, longitude: 121.5654 },
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    return result.game.id as string;
  }

  async function addTreasure(gameId: string, title = "湖畔寶藏"): Promise<Response> {
    return adminRequest(`/admin/games/${gameId}/treasures`, "POST", {
      title,
      description: "靠近湖邊的寶藏",
      latitude: 25.000001,
      longitude: 121.000002,
      fuzzyLatitude: 25.000501,
      fuzzyLongitude: 121.000502,
      fuzzyRadiusMeters: 100,
      enabled: true,
      sortOrder: 0,
    });
  }

  it("allows only authorized administrators to test Mock GPS on drafts without creating game records", async () => {
    const gameId = await createDraft();
    const treasureResponse = await addTreasure(gameId);
    const { treasure } = await treasureResponse.json();
    const path = `/admin/games/${gameId}/mock-gps/test`;
    const requestBody = {
      treasureId: treasure.id,
      latitude: 25.000001,
      longitude: 121.000002,
      accuracy: 5,
    };
    const unauthorizedResponse = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await adminRequest(path, "POST", requestBody);
    const result = await response.json();

    expect(unauthorizedResponse.status).toBe(403);
    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      mode: "mock",
      treasureId: treasure.id,
      distanceMeters: expect.any(Number),
      thresholdMeters: COLLECTION_THRESHOLD_METERS,
      accuracyAccepted: true,
      collectible: true,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM game_participants").get(),
    ).toEqual({ count: 0 });
  });

  it("uses the production distance and accuracy thresholds but rejects published games", async () => {
    const gameId = await createDraft();
    const treasureResponse = await addTreasure(gameId);
    const { treasure } = await treasureResponse.json();
    const path = `/admin/games/${gameId}/mock-gps/test`;
    const tooFar = await adminRequest(path, "POST", {
      treasureId: treasure.id,
      latitude:
        25.000001 +
        ((COLLECTION_THRESHOLD_METERS + 0.1) / 6_371_000) * (180 / Math.PI),
      longitude: 121.000002,
      accuracy: 1,
    });
    const inaccurate = await adminRequest(path, "POST", {
      treasureId: treasure.id,
      latitude: 25.000001,
      longitude: 121.000002,
      accuracy: 50.01,
    });
    const publishResponse = await adminRequest(`/admin/games/${gameId}/publish`, "POST");
    const publishedTest = await adminRequest(path, "POST", {
      treasureId: treasure.id,
      latitude: 25.000001,
      longitude: 121.000002,
      accuracy: 5,
    });

    expect(tooFar.status).toBe(200);
    expect(await tooFar.json()).toMatchObject({
      accuracyAccepted: true,
      collectible: false,
      thresholdMeters: COLLECTION_THRESHOLD_METERS,
    });
    expect(inaccurate.status).toBe(200);
    expect(await inaccurate.json()).toMatchObject({
      accuracyAccepted: false,
      collectible: false,
    });
    expect(publishResponse.status).toBe(200);
    expect(publishedTest.status).toBe(409);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 0 });
  });

  it("creates, reads, updates, and deletes draft treasures while keeping target count in sync", async () => {
    const gameId = await createDraft();
    const createdResponse = await addTreasure(gameId);
    const createdResult = await createdResponse.json();

    expect(createdResponse.status).toBe(201);
    expect(createdResult).toMatchObject({
      treasure: {
        title: "湖畔寶藏",
        description: "靠近湖邊的寶藏",
        latitude: 25.000001,
        longitude: 121.000002,
        fuzzyLatitude: 25.000501,
        fuzzyLongitude: 121.000502,
        fuzzyRadiusMeters: 100,
        enabled: true,
        sortOrder: 0,
      },
      totalTreasuresCount: 1,
    });
    expect(createdResult.treasure.id).toEqual(expect.any(String));

    const listResponse = await adminRequest(`/admin/games/${gameId}/treasures`, "GET");
    const listResult = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listResult.totalTreasuresCount).toBe(1);
    expect(listResult.treasures).toHaveLength(1);

    const updateResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${createdResult.treasure.id}`,
      "PATCH",
      {
        title: "更新後的寶藏",
        latitude: 25.1,
        fuzzyLatitude: 25.2,
        fuzzyRadiusMeters: 250,
        enabled: false,
      },
    );
    const updateResult = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updateResult).toMatchObject({
      treasure: {
        id: createdResult.treasure.id,
        title: "更新後的寶藏",
        latitude: 25.1,
        longitude: 121.000002,
        fuzzyLatitude: 25.2,
        fuzzyLongitude: 121.000502,
        fuzzyRadiusMeters: 250,
        enabled: false,
      },
      totalTreasuresCount: 0,
    });
    const reenabledResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${createdResult.treasure.id}`,
      "PATCH",
      { enabled: true },
    );
    expect(reenabledResponse.status).toBe(200);
    expect(await reenabledResponse.json()).toMatchObject({ totalTreasuresCount: 1 });

    const missingDeleteConfirmation = await adminRequest(
      `/admin/games/${gameId}/treasures/${createdResult.treasure.id}`,
      "DELETE",
    );
    const deleteResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${createdResult.treasure.id}`,
      "DELETE",
      { confirmPermanentDeletion: true },
    );
    const afterDelete = await adminRequest(`/admin/games/${gameId}/treasures`, "GET");
    const afterDeleteResult = await afterDelete.json();
    expect(missingDeleteConfirmation.status).toBe(400);
    expect(deleteResponse.status).toBe(204);
    expect(afterDeleteResult).toMatchObject({ treasures: [], totalTreasuresCount: 0 });
  });

  it("validates treasure coordinates, fuzzy-zone radius, title, and rounded duplicate coordinates", async () => {
    const gameId = await createDraft();
    const invalidCoordinate = await adminRequest(`/admin/games/${gameId}/treasures`, "POST", {
      title: "無效座標",
      latitude: 91,
      longitude: 121,
      fuzzyLatitude: 25,
      fuzzyLongitude: 121,
    });
    const invalidRadius = await adminRequest(`/admin/games/${gameId}/treasures`, "POST", {
      title: "無效半徑",
      latitude: 25,
      longitude: 121,
      fuzzyLatitude: 25.1,
      fuzzyLongitude: 121.1,
      fuzzyRadiusMeters: 19,
    });
    const missingTitle = await adminRequest(`/admin/games/${gameId}/treasures`, "POST", {
      latitude: 25,
      longitude: 121,
      fuzzyLatitude: 25.1,
      fuzzyLongitude: 121.1,
    });
    const first = await addTreasure(gameId);
    const duplicate = await adminRequest(`/admin/games/${gameId}/treasures`, "POST", {
      title: "重複座標",
      latitude: 25.0000012,
      longitude: 121.0000023,
      fuzzyLatitude: 25.1,
      fuzzyLongitude: 121.1,
    });

    expect(invalidCoordinate.status).toBe(400);
    expect(invalidRadius.status).toBe(400);
    expect(missingTitle.status).toBe(400);
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?").get(gameId),
    ).toEqual({ count: 1 });
  });

  it("rejects the 501st treasure and reports the exact target count", async () => {
    const gameId = await createDraft();
    const insertTreasure = database.prepare(
      `INSERT INTO treasures (
        id, game_id, title, description, latitude, longitude,
        fuzzy_latitude, fuzzy_longitude, fuzzy_radius_meters,
        enabled, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, '', 25, 121, 25.1, 121.1, 100, 1, ?, ?, ?)`,
    );
    database.exec("BEGIN");
    try {
      for (let index = 0; index < 500; index += 1) {
        insertTreasure.run(`seed-${index}`, gameId, `寶藏-${index}`, index, now, now);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const response = await addTreasure(gameId, "超過上限");
    const result = await response.json();

    expect(response.status).toBe(409);
    expect(result).toMatchObject({ totalTreasuresCount: 500 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?").get(gameId),
    ).toEqual({ count: 500 });
  });

  it("locks treasure content after publication but permits disabling without deleting records", async () => {
    const gameId = await createDraft();
    const createdResponse = await addTreasure(gameId);
    const createdResult = await createdResponse.json();
    const treasureId = createdResult.treasure.id as string;

    expect((await adminRequest(`/admin/games/${gameId}/publish`, "POST")).status).toBe(200);
    const locationUpdate = await adminRequest(
      `/admin/games/${gameId}/treasures/${treasureId}`,
      "PATCH",
      { latitude: 25.2 },
    );
    const disableResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${treasureId}`,
      "PATCH",
      { enabled: false },
    );
    const deleteResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${treasureId}`,
      "DELETE",
      { confirmPermanentDeletion: true },
    );
    const disabledResult = await disableResponse.json();
    const idempotentDisableResponse = await adminRequest(
      `/admin/games/${gameId}/treasures/${treasureId}`,
      "PATCH",
      { enabled: false },
    );
    const treasure = database
      .prepare("SELECT enabled, latitude FROM treasures WHERE id = ?")
      .get(treasureId);

    expect(locationUpdate.status).toBe(409);
    expect(disableResponse.status).toBe(200);
    expect(disabledResult.totalTreasuresCount).toBe(0);
    expect(idempotentDisableResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(409);
    expect(treasure).toEqual({ enabled: 0, latitude: 25.000001 });
  });

  it("does not expose precise treasure coordinates through player game APIs", async () => {
    const gameId = await createDraft();
    await addTreasure(gameId);
    await adminRequest(`/admin/games/${gameId}/publish`, "POST");
    const requestResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com" }),
    });
    expect(requestResponse.status).toBe(202);
    const loginResponse = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: mailer.tokens[0] }),
    });
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a session cookie");
    }

    const gameResponse = await fetch(`${baseUrl}/games/${gameId}`, {
      headers: { cookie },
    });
    const treasureResponse = await fetch(`${baseUrl}/games/${gameId}/treasures`, {
      headers: { cookie },
    });
    const joinResponse = await fetch(`${baseUrl}/games/${gameId}/join`, {
      method: "POST",
      headers: { cookie },
    });
    const gameText = await gameResponse.text();
    const joinText = await joinResponse.text();

    expect(gameResponse.status).toBe(200);
    expect(treasureResponse.status).toBe(404);
    expect(joinResponse.status).toBe(200);
    expect(gameText).not.toContain("25.000001");
    expect(gameText).not.toContain("treasures");
    expect(joinText).not.toContain("25.000001");
    expect(joinText).not.toContain("121.000002");
  });
});
