import { DatabaseSync } from "node:sqlite";
import { completeMagicLinkLogin } from "./helpers/auth-flow.js";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";

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

describe("伺服器端 API 限流", () => {
  let database: DatabaseSync;
  let mailer: TestMagicLinkSender;
  let server: Server;
  let baseUrl: string;
  let now: number;
  let nextId: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    mailer = new TestMagicLinkSender();
    now = Date.UTC(2026, 0, 1);
    nextId = 0;
    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      createToken: () => `rate-limit-token-${mailer.tokens.length + 1}`,
      createId: () => `rate-limit-id-${++nextId}`,
      trustProxyHops: 1,
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

  async function requestMagicLink(
    email: string,
    forwardedFor?: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
      },
      body: JSON.stringify({ email }),
    });
  }

  async function createPlayer(email: string): Promise<string> {
    const requestResponse = await requestMagicLink(email);
    expect(requestResponse.status).toBe(202);
    const token = mailer.tokens.at(-1);
    if (!token) {
      throw new Error("Expected a player Magic Link");
    }
    const response = await completeMagicLinkLogin(baseUrl, token, requestResponse.headers.get("X-Auth-Request-Token")!, mailer.requestIds.get(token)!);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a player session cookie");
    }
    const result = await response.json();
    return cookie;
  }

  async function createPlayingGame(
    cookie: string,
    email: string,
  ): Promise<{ gameId: string; treasureId: string }> {
    const player = database
      .prepare("SELECT id FROM players WHERE email = ?")
      .get(email) as { id: string };
    const gameId = `game-${player.id}`;
    const treasureId = `treasure-${player.id}`;
    database
      .prepare(
        `INSERT INTO games (
          id, name, description, starts_at, ends_at, timezone,
          map_center_latitude, map_center_longitude, status, created_at, updated_at
        ) VALUES (?, '限流測試', '', ?, ?, 'Asia/Taipei', 25, 121, 'published', ?, ?)`,
      )
      .run(gameId, now - 60_000, now + 60_000, now, now);
    database
      .prepare(
        `INSERT INTO treasures (
          id, game_id, title, latitude, longitude, fuzzy_latitude,
          fuzzy_longitude, fuzzy_radius_meters, enabled, sort_order,
          created_at, updated_at
        ) VALUES (?, ?, '測試寶藏', 25, 121, 25, 121, 100, 1, 0, ?, ?)`,
      )
      .run(treasureId, gameId, now, now);
    database
      .prepare(
        `INSERT INTO game_participants (
          game_id, player_id, status, progress_json, created_at, updated_at
        ) VALUES (?, ?, 'playing', '{}', ?, ?)`,
      )
      .run(gameId, player.id, now, now);
    return { gameId, treasureId };
  }

  async function postCollection(
    gameId: string,
    treasureId: string,
    cookie: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}/games/${gameId}/treasures/${treasureId}/collect`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        latitude: 25,
        longitude: 121,
        accuracy: 5,
        timestamp: now,
      }),
    });
  }

  it("limits Magic Links to five per normalized email per 15 minutes", async () => {
    const responses: Response[] = [];
    for (let index = 0; index < 5; index += 1) {
      responses.push(
        await requestMagicLink(" Player@Example.com ", `198.51.100.${index + 1}`),
      );
    }
    const limited = await requestMagicLink(
      "player@example.com",
      "198.51.100.6",
    );
    const result = await limited.json();

    expect(responses.map(({ status }) => status)).toEqual([202, 202, 202, 202, 202]);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(result).toMatchObject({ error: expect.any(String), retryAfterSeconds: expect.any(Number) });
    expect(mailer.tokens).toHaveLength(5);

    now += 15 * 60 * 1000;
    expect(
      (
        await requestMagicLink("player@example.com", "198.51.100.7")
      ).status,
    ).toBe(202);
  });

  it("limits Magic Links to five per remote IP even across different email addresses", async () => {
    const responses: Response[] = [];
    for (let index = 0; index < 5; index += 1) {
      responses.push(await requestMagicLink(`ip-${index}@example.com`));
    }
    const limited = await requestMagicLink("sixth@example.com");

    expect(responses.every(({ status }) => status === 202)).toBe(true);
    expect(limited.status).toBe(429);
    expect(mailer.tokens).toHaveLength(5);
  });

  it("limits player location reports to one request every five seconds", async () => {
    const cookie = await createPlayer("location-limit@example.com");
    const { gameId } = await createPlayingGame(cookie, "location-limit@example.com");
    const sendLocation = () =>
      fetch(`${baseUrl}/games/${gameId}/location`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          latitude: 25,
          longitude: 121,
          accuracy: 5,
          timestamp: now,
        }),
      });

    expect((await sendLocation()).status).toBe(200);
    const limited = await sendLocation();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    now += 5_000;
    expect((await sendLocation()).status).toBe(200);
  });

  it("limits a player to ten collection attempts per minute without changing idempotent results", async () => {
    const email = "collection-limit@example.com";
    const cookie = await createPlayer(email);
    const { gameId, treasureId } = await createPlayingGame(cookie, email);
    const responses: Response[] = [];
    for (let index = 0; index < 10; index += 1) {
      responses.push(await postCollection(gameId, treasureId, cookie));
    }
    const limited = await postCollection(gameId, treasureId, cookie);

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(limited.status).toBe(429);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM collected_treasures").get(),
    ).toEqual({ count: 1 });
    now += 60_000;
    expect((await postCollection(gameId, treasureId, cookie)).status).toBe(200);
  });

  it("limits leaderboard requests to 30 per player per minute", async () => {
    const cookie = await createPlayer("leaderboard-limit@example.com");
    const responses: Response[] = [];
    for (let index = 0; index < 30; index += 1) {
      responses.push(await fetch(`${baseUrl}/leaderboard`, { headers: { cookie } }));
    }
    const limited = await fetch(`${baseUrl}/leaderboard`, { headers: { cookie } });

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(limited.status).toBe(429);
    now += 60_000;
    expect((await fetch(`${baseUrl}/leaderboard`, { headers: { cookie } })).status).toBe(
      200,
    );
  });
});
