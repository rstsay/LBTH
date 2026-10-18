import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";

class TestMagicLinkSender implements MagicLinkSender {
  async send(): Promise<void> {}
}

interface TreasureInput {
  title: string;
  latitude: number;
  longitude: number;
  fuzzyLatitude: number;
  fuzzyLongitude: number;
  [key: string]: unknown;
}

describe("JSON 寶藏匯入與預覽", () => {
  let database: DatabaseSync;
  let server: Server;
  let baseUrl: string;
  let now: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    now = Date.UTC(2026, 0, 1, 3);
    const app = createAuthApp({
      database,
      mailer: new TestMagicLinkSender(),
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      authorizeAdmin: (request) => request.header("x-test-admin") === "yes",
      createId: (() => {
        let id = 0;
        return () => `import-id-${++id}`;
      })(),
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
    body?: unknown,
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
      name: "匯入測試場",
      startsAt: "2026-01-01T10:00:00+08:00",
      endsAt: "2026-01-01T12:00:00+08:00",
      timezone: "Asia/Taipei",
      mapCenter: { latitude: 25.033, longitude: 121.5654 },
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    return result.game.id as string;
  }

  function treasure(
    title: string,
    latitude: number,
    longitude: number,
    overrides: Record<string, unknown> = {},
  ): TreasureInput {
    return {
      title,
      latitude,
      longitude,
      fuzzyLatitude: latitude + 0.001,
      fuzzyLongitude: longitude + 0.001,
      ...overrides,
    };
  }

  function payload(
    treasures: unknown[],
    schemaVersion: unknown = 1,
  ): { schemaVersion: unknown; treasures: unknown[] } {
    return { schemaVersion, treasures };
  }

  function importPath(gameId: string, suffix: "preview" | "commit"): string {
    return `/admin/games/${gameId}/treasures/import/${suffix}`;
  }

  it("previews normalized valid treasure data without writing to the database", async () => {
    const gameId = await createDraft();
    const response = await adminRequest(
      importPath(gameId, "preview"),
      "POST",
      payload([
        {
          ...treasure("預覽寶藏", 25, 121),
          fuzzyRadiusMeters: undefined,
          enabled: undefined,
          sortOrder: undefined,
        },
      ]),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      validCount: 1,
      errorCount: 0,
      errors: [],
      preview: [
        {
          row: 1,
          title: "預覽寶藏",
          latitude: 25,
          longitude: 121,
          fuzzyLatitude: 25.001,
          fuzzyLongitude: 121.001,
          fuzzyRadiusMeters: 100,
          enabled: true,
          sortOrder: 0,
        },
      ],
    });
    expect(result.preview[0].id).toBeUndefined();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?").get(gameId),
    ).toEqual({ count: 0 });
  });

  it("reports row, field, code, and reason for missing fields, invalid types, coordinates, radius, and duplicate locations", async () => {
    const gameId = await createDraft();
    const response = await adminRequest(
      importPath(gameId, "preview"),
      "POST",
      payload([
        treasure("有效寶藏", 25, 121),
        { ...treasure("缺熱區緯度", 25, 121), fuzzyLatitude: undefined },
        treasure("型別錯誤", "25" as unknown as number, 121),
        treasure("座標超界", 91, 121),
        treasure("半徑過小", 26, 122, { fuzzyRadiusMeters: 19 }),
        treasure("重複座標", 25.0000001, 121.0000001),
        treasure("無效 ID", 27, 123, { id: "caller-id" }),
      ]),
    );
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.validCount).toBe(1);
    expect(result.errorCount).toBe(8);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 2,
          field: "fuzzyLatitude",
          code: "REQUIRED",
          reason: expect.any(String),
        }),
        expect.objectContaining({
          row: 3,
          field: "latitude",
          code: "INVALID_TYPE",
          reason: expect.any(String),
        }),
        expect.objectContaining({
          row: 4,
          field: "latitude",
          code: "OUT_OF_RANGE",
          reason: expect.any(String),
        }),
        expect.objectContaining({
          row: 5,
          field: "fuzzyRadiusMeters",
          code: "OUT_OF_RANGE",
          reason: expect.any(String),
        }),
        expect.objectContaining({
          row: 6,
          field: "latitude",
          code: "DUPLICATE_COORDINATES",
          reason: expect.any(String),
        }),
        expect.objectContaining({
          row: 7,
          field: "id",
          code: "UNSUPPORTED_FIELD",
          reason: expect.any(String),
        }),
      ]),
    );
  });

  it("rejects unsupported schema versions and input arrays exceeding 500 rows", async () => {
    const gameId = await createDraft();
    const wrongVersionResponse = await adminRequest(
      importPath(gameId, "preview"),
      "POST",
      payload([], 2),
    );
    const tooManyResponse = await adminRequest(
      importPath(gameId, "preview"),
      "POST",
      payload(Array.from({ length: 501 }, (_, index) => treasure(`寶藏-${index}`, 20, 100 + index / 1000))),
    );
    const wrongVersion = await wrongVersionResponse.json();
    const tooMany = await tooManyResponse.json();

    expect(wrongVersionResponse.status).toBe(400);
    expect(wrongVersion.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 0,
          field: "schemaVersion",
          code: "UNSUPPORTED_VERSION",
          reason: expect.any(String),
        }),
      ]),
    );
    expect(tooManyResponse.status).toBe(400);
    expect(tooMany.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 0,
          field: "treasures",
          code: "TOO_MANY_ROWS",
          reason: expect.any(String),
        }),
      ]),
    );
  });

  it("all-or-nothing mode writes no rows if any row has an error", async () => {
    const gameId = await createDraft();
    const response = await adminRequest(importPath(gameId, "commit"), "POST", {
      ...payload([treasure("有效列", 25, 121), treasure("", 26, 122)]),
      mode: "all_or_nothing",
    });
    const result = await response.json();

    expect(response.status).toBe(400);
    expect(result.importedCount).toBe(0);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 2, field: "title" })]),
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?").get(gameId),
    ).toEqual({ count: 0 });
  });

  it("rolls back every valid row if a write fails during the import transaction", async () => {
    const gameId = await createDraft();
    database.exec(`
      CREATE TRIGGER reject_test_import_row
      BEFORE INSERT ON treasures
      WHEN NEW.title = '觸發寫入失敗'
      BEGIN
        SELECT RAISE(ABORT, 'simulated write failure');
      END;
    `);

    const response = await adminRequest(importPath(gameId, "commit"), "POST", {
      ...payload([
        treasure("先寫入但必須回滾", 25, 121),
        treasure("觸發寫入失敗", 26, 122),
      ]),
      mode: "skip_invalid",
    });
    const result = await response.json();

    expect(response.status).toBe(500);
    expect(result).toMatchObject({
      importedCount: 0,
      error: expect.any(String),
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?").get(gameId),
    ).toEqual({ count: 0 });
  });

  it("skip-invalid mode imports only valid rows atomically and leaves the game as a draft", async () => {
    const gameId = await createDraft();
    const response = await adminRequest(importPath(gameId, "commit"), "POST", {
      ...payload([
        treasure("第一筆有效", 25, 121),
        treasure("無效半徑", 26, 122, { fuzzyRadiusMeters: 1001 }),
        treasure("第二筆有效", 27, 123, { enabled: false }),
      ]),
      mode: "skip_invalid",
    });
    const result = await response.json();
    const stored = database
      .prepare("SELECT title, enabled, sort_order FROM treasures WHERE game_id = ? ORDER BY sort_order")
      .all(gameId);
    const game = database.prepare("SELECT status FROM games WHERE id = ?").get(gameId);

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      importedCount: 2,
      totalTreasuresCount: 1,
      errors: [expect.objectContaining({ row: 2, field: "fuzzyRadiusMeters" })],
    });
    expect(result.imported).toHaveLength(2);
    expect(stored).toEqual([
      { title: "第一筆有效", enabled: 1, sort_order: 0 },
      { title: "第二筆有效", enabled: 0, sort_order: 2 },
    ]);
    expect(game).toEqual({ status: "draft" });
  });

  it("does not import rows that duplicate existing treasures and enforces remaining game capacity", async () => {
    const gameId = await createDraft();
    const existing = await adminRequest(`/admin/games/${gameId}/treasures`, "POST", {
      ...treasure("既有寶藏", 25, 121),
    });
    expect(existing.status).toBe(201);

    const duplicateResponse = await adminRequest(importPath(gameId, "preview"), "POST", payload([
      treasure("與既有重複", 25.0000001, 121.0000001),
    ]));
    const duplicate = await duplicateResponse.json();
    expect(duplicate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 1,
          field: "latitude",
          code: "DUPLICATE_COORDINATES",
        }),
      ]),
    );

    const fillToLimit = database.prepare(
      `INSERT INTO treasures (
        id, game_id, title, description, latitude, longitude,
        fuzzy_latitude, fuzzy_longitude, fuzzy_radius_meters,
        enabled, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, 25, 121, 100, 1, ?, ?, ?)`,
    );
    for (let index = 0; index < 499; index += 1) {
      fillToLimit.run(`existing-${index}`, gameId, `既存-${index}`, -80 + index / 100, 50, index, now, now);
    }
    const capacityResponse = await adminRequest(importPath(gameId, "commit"), "POST", {
      ...payload([treasure("超出單場上限", 40, 100)]),
      mode: "skip_invalid",
    });
    const capacity = await capacityResponse.json();

    expect(capacityResponse.status).toBe(400);
    expect(capacity.importedCount).toBe(0);
    expect(capacity.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 1,
          field: "treasures",
          code: "GAME_CAPACITY_EXCEEDED",
        }),
      ]),
    );
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM treasures WHERE game_id = ?").get(gameId),
    ).toEqual({ count: 500 });
  });
});
