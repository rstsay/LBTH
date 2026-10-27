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

describe("玩家進度與全站排行榜", () => {
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
      createToken: () => `leaderboard-token-${mailer.tokens.length + 1}`,
      createId: () => `leaderboard-id-${++nextId}`,
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

  async function createPlayer(email: string): Promise<{
    playerId: string;
    cookie: string;
  }> {
    const magicResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(magicResponse.status).toBe(202);
    const token = mailer.tokens[mailer.tokens.length - 1]!;
    const verifyResponse = await completeMagicLinkLogin(baseUrl, token, magicResponse.headers.get("X-Auth-Request-Token")!, mailer.requestIds.get(token)!);
    expect(verifyResponse.status).toBe(200);
    const cookie = verifyResponse.headers.get("set-cookie")?.split(";")[0];
    const { player } = await verifyResponse.json();
    if (!cookie || typeof player?.id !== "string") {
      throw new Error("Expected an authenticated player");
    }
    return { playerId: player.id, cookie };
  }

  function seedGame(gameId: string, name: string, treasureCount: number): string[] {
    database
      .prepare(
        `INSERT INTO games (
          id, name, description, starts_at, ends_at, timezone,
          map_center_latitude, map_center_longitude, status,
          ended_at, archive_restored_at, created_at, updated_at
        ) VALUES (?, ?, '', ?, ?, 'Asia/Taipei', 25, 121, 'ended', ?, NULL, ?, ?)`,
      )
      .run(gameId, name, now - 10_000, now - 1_000, now - 1_000, now - 20_000, now);
    const insertTreasure = database.prepare(
      `INSERT INTO treasures (
        id, game_id, title, description, latitude, longitude,
        fuzzy_latitude, fuzzy_longitude, fuzzy_radius_meters,
        enabled, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, '', 25, 121, 25.1, 121.1, 100, 1, ?, ?, ?)`,
    );
    const ids = Array.from({ length: treasureCount }, (_, index) => `${gameId}-t${index + 1}`);
    ids.forEach((id, index) =>
      insertTreasure.run(id, gameId, `寶藏 ${index + 1}`, index, now, now),
    );
    return ids;
  }

  function seedPlayerGame(
    playerId: string,
    gameId: string,
    treasureIds: string[],
    collectedCount: number,
    firstCollectedAt: number,
  ): void {
    database
      .prepare(
        `INSERT INTO game_participants (
          game_id, player_id, status, progress_json, created_at, updated_at
        ) VALUES (?, ?, 'exited', '{}', ?, ?)`,
      )
      .run(gameId, playerId, now, now);
    const insertCollection = database.prepare(
      `INSERT INTO collected_treasures (
        game_id, player_id, treasure_id, collected_at, distance_meters, accuracy
      ) VALUES (?, ?, ?, ?, 2, 5)`,
    );
    for (let index = 0; index < collectedCount; index += 1) {
      insertCollection.run(
        gameId,
        playerId,
        treasureIds[index],
        firstCollectedAt + index,
      );
    }
  }

  async function patchProfile(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${baseUrl}/auth/me`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lets players update their display name and leaderboard visibility without losing personal totals", async () => {
    const player = await createPlayer("profile@example.com");
    const initialResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: player.cookie },
    });
    const initial = await initialResponse.json();
    const gameTreasures = seedGame("profile-game", "個人進度場", 1);
    seedPlayerGame(player.playerId, "profile-game", gameTreasures, 1, now);

    const updateResponse = await patchProfile(player.cookie, {
      nickname: "  尋寶高手  ",
      leaderboardVisible: false,
    });
    const updated = await updateResponse.json();
    const currentResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: player.cookie },
    });
    const current = await currentResponse.json();
    const leaderboardResponse = await fetch(`${baseUrl}/leaderboard`);
    const leaderboard = await leaderboardResponse.json();

    expect(initialResponse.status).toBe(200);
    expect(initialResponse.headers.get("cache-control")).toBe("no-store");
    expect(initial.player).toMatchObject({
      nickname: null,
      leaderboardVisible: true,
      totalCollectedSoFar: 0,
    });
    expect(updateResponse.status).toBe(200);
    expect(updated.player).toMatchObject({
      nickname: "尋寶高手",
      leaderboardVisible: false,
    });
    expect(current.player).toMatchObject({
      nickname: "尋寶高手",
      leaderboardVisible: false,
      totalCollectedSoFar: 1,
    });
    expect(leaderboard.leaderboard).toEqual([]);
  });

  it("returns only the top three public players ordered by total, completions, and earliest achievement", async () => {
    const alpha = await createPlayer("alpha@example.com");
    const bravo = await createPlayer("bravo@example.com");
    const charlie = await createPlayer("charlie@example.com");
    const delta = await createPlayer("delta@example.com");
    const firstGameTreasures = seedGame("rank-game-a", "排名場 A", 2);
    const secondGameTreasures = seedGame("rank-game-b", "排名場 B", 3);
    const thirdGameTreasures = seedGame("rank-game-c", "排名場 C", 1);
    seedPlayerGame(alpha.playerId, "rank-game-a", firstGameTreasures, 2, now - 500);
    seedPlayerGame(alpha.playerId, "rank-game-c", thirdGameTreasures, 1, now - 300);
    seedPlayerGame(bravo.playerId, "rank-game-b", secondGameTreasures, 3, now - 400);
    seedPlayerGame(charlie.playerId, "rank-game-a", firstGameTreasures, 2, now - 200);
    seedPlayerGame(charlie.playerId, "rank-game-b", secondGameTreasures, 1, now - 100);
    seedPlayerGame(delta.playerId, "rank-game-a", firstGameTreasures, 2, now - 50);
    await patchProfile(alpha.cookie, { nickname: "甲" });
    await patchProfile(bravo.cookie, { nickname: "乙" });
    await patchProfile(charlie.cookie, { nickname: "丙" });
    await patchProfile(delta.cookie, { nickname: "丁" });

    const response = await fetch(`${baseUrl}/leaderboard`);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(result.leaderboard).toEqual([
      { rank: 1, displayName: "甲", totalCollected: 3, completedGames: 2 },
      { rank: 2, displayName: "乙", totalCollected: 3, completedGames: 1 },
      { rank: 3, displayName: "丙", totalCollected: 3, completedGames: 1 },
    ]);
  });

  it("returns authoritative game progress and reflects permanent game deletion in leaderboard totals", async () => {
    const player = await createPlayer("progress@example.com");
    const gameTreasures = seedGame("progress-game", "已結束的進度場", 2);
    const retainedTreasures = seedGame("retained-game", "保留累計場", 1);
    seedPlayerGame(player.playerId, "progress-game", gameTreasures, 1, now - 100);
    seedPlayerGame(player.playerId, "retained-game", retainedTreasures, 1, now - 50);
    await patchProfile(player.cookie, { nickname: "進度玩家" });

    const progressResponse = await fetch(
      `${baseUrl}/games/progress-game/progress`,
      { headers: { cookie: player.cookie } },
    );
    const progress = await progressResponse.json();

    expect(progressResponse.status).toBe(200);
    expect(progressResponse.headers.get("cache-control")).toBe("no-store");
    expect(progress).toMatchObject({
      gameId: "progress-game",
      gameName: "已結束的進度場",
      collectedTreasureIds: [`progress-game-t1`],
      collectedCount: 1,
      remainingCount: 1,
      targetTreasureCount: 2,
      completionRate: 50,
      completed: false,
      totalCollectedSoFar: 2,
    });

    now += 7 * 24 * 60 * 60 * 1000;
    const deleteResponse = await fetch(`${baseUrl}/admin/games/progress-game`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-test-admin": "yes",
      },
      body: JSON.stringify({ confirmPermanentDeletion: true }),
    });
    const leaderboardResponse = await fetch(`${baseUrl}/leaderboard`);
    const leaderboard = await leaderboardResponse.json();

    expect(deleteResponse.status).toBe(204);
    expect(leaderboard.leaderboard).toEqual([
      {
        rank: 1,
        displayName: "進度玩家",
        totalCollected: 1,
        completedGames: 1,
      },
    ]);
  });

  it("rejects invalid profile fields and requires authentication to read personal progress", async () => {
    const player = await createPlayer("validation@example.com");
    const invalidNickname = await patchProfile(player.cookie, {
      nickname: "x".repeat(31),
    });
    const invalidVisibility = await patchProfile(player.cookie, {
      leaderboardVisible: "false",
    });
    const invalidField = await patchProfile(player.cookie, {
      email: "changed@example.com",
    });
    const unauthenticated = await fetch(
      `${baseUrl}/games/nonexistent/progress`,
    );

    expect(invalidNickname.status).toBe(400);
    expect(invalidVisibility.status).toBe(400);
    expect(invalidField.status).toBe(400);
    expect(unauthenticated.status).toBe(401);
  });
});
