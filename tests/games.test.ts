import { DatabaseSync } from "node:sqlite";
import { completeMagicLinkLogin } from "./helpers/auth-flow.js";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthApp, type MagicLinkSender } from "../src/auth.ts";

interface SentLink {
  email: string;
  token: string;
  requestId: string;
}

class TestMagicLinkSender implements MagicLinkSender {
  readonly sent: SentLink[] = [];

  async send(email: string, url: string): Promise<void> {
    const token = new URL(url).searchParams.get("token");
    const requestId = new URL(url).searchParams.get("requestId");
    if (!token || !requestId) {
      throw new Error("Expected token in magic link URL");
    }
    this.sent.push({ email, token, requestId });
  }
}

describe("遊戲管理與生命週期", () => {
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
    now = Date.UTC(2026, 0, 1, 1);
    nextId = 0;
    nextToken = 0;

    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      createToken: () => `test-token-${++nextToken}`,
      createId: () => `test-id-${++nextId}`,
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

  async function createDraft(name: string, startsAt: string, endsAt: string): Promise<string> {
    const response = await adminRequest("/admin/games", "POST", {
      name,
      description: `${name} 活動`,
      startsAt,
      endsAt,
      timezone: "Asia/Taipei",
      mapCenter: { latitude: 25.033, longitude: 121.5654 },
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    return result.game.id as string;
  }

  async function publishGame(gameId: string): Promise<Response> {
    return adminRequest(`/admin/games/${gameId}/publish`, "POST");
  }

  async function login(email = "player@example.com"): Promise<string> {
    const requestResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(requestResponse.status).toBe(202);
    const link = mailer.sent.at(-1);
    if (!link) {
      throw new Error("Expected a magic link");
    }
    const response = await completeMagicLinkLogin(baseUrl, link.token, requestResponse.headers.get("X-Auth-Request-Token")!, link.requestId);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a session cookie");
    }
    return cookie;
  }

  async function playerRequest(
    cookie: string,
    path: string,
    method: string,
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie },
    });
  }

  it("requires administrator authorization to manage games", async () => {
    const response = await fetch(`${baseUrl}/admin/games`);

    expect(response.status).toBe(403);
  });

  it("publishes overlapping games and returns UTC times with their activity timezone", async () => {
    const firstId = await createDraft(
      "早場",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    const secondId = await createDraft(
      "午場",
      "2026-01-01T11:00:00+08:00",
      "2026-01-01T13:00:00+08:00",
    );

    expect((await publishGame(firstId)).status).toBe(200);
    expect((await publishGame(secondId)).status).toBe(200);
    const response = await adminRequest("/admin/games", "GET");
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.games).toHaveLength(2);
    expect(result.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstId,
          name: "早場",
          status: "scheduled",
          timezone: "Asia/Taipei",
          startsAt: "2026-01-01T02:00:00.000Z",
          endsAt: "2026-01-01T04:00:00.000Z",
        }),
        expect.objectContaining({
          id: secondId,
          status: "scheduled",
        }),
      ]),
    );

    now = Date.UTC(2026, 0, 1, 3);
    const cookie = await login();
    const publicResponse = await fetch(`${baseUrl}/games`, {
      headers: { cookie },
    });
    const publicResult = await publicResponse.json();
    expect(publicResponse.status).toBe(200);
    expect(publicResult.games).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, status: "active" }),
        expect.objectContaining({ id: secondId, status: "active" }),
      ]),
    );
  });

  it("validates drafts, permits editing only before publication, and allows draft deletion", async () => {
    const invalidResponse = await adminRequest("/admin/games", "POST", {
      name: "錯誤時段",
      startsAt: "2026-01-01T12:00:00+08:00",
      endsAt: "2026-01-01T10:00:00+08:00",
      timezone: "Asia/Taipei",
      mapCenter: { latitude: 25, longitude: 121 },
    });
    expect(invalidResponse.status).toBe(400);

    const draftId = await createDraft(
      "草稿",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    const updateResponse = await adminRequest(`/admin/games/${draftId}`, "PATCH", {
      name: "草稿已更新",
    });
    expect(updateResponse.status).toBe(200);
    expect((await publishGame(draftId)).status).toBe(200);

    const lockedResponse = await adminRequest(`/admin/games/${draftId}`, "PATCH", {
      name: "發布後不可修改",
    });
    const deleteDraftId = await createDraft(
      "待刪草稿",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    const missingDeleteConfirmation = await adminRequest(
      `/admin/games/${deleteDraftId}`,
      "DELETE",
    );
    const deleteResponse = await adminRequest(
      `/admin/games/${deleteDraftId}`,
      "DELETE",
      { confirmPermanentDeletion: true },
    );

    expect(lockedResponse.status).toBe(409);
    expect(missingDeleteConfirmation.status).toBe(400);
    expect(deleteResponse.status).toBe(204);
  });

  it("allows one active game per player and restores per-game progress after switching", async () => {
    now = Date.UTC(2026, 0, 1, 3);
    const firstId = await createDraft(
      "第一場",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    const secondId = await createDraft(
      "第二場",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(firstId);
    await publishGame(secondId);
    const cookie = await login();

    const joinFirst = await playerRequest(cookie, `/games/${firstId}/join`, "POST");
    const firstResult = await joinFirst.json();
    database
      .prepare("UPDATE game_participants SET progress_json = ? WHERE game_id = ?")
      .run('{"collectedTreasureIds":["treasure-1"]}', firstId);

    const simultaneousJoin = await playerRequest(cookie, `/games/${secondId}/join`, "POST");
    const pauseFirst = await playerRequest(cookie, `/games/${firstId}/pause`, "POST");
    const joinSecond = await playerRequest(cookie, `/games/${secondId}/join`, "POST");
    const pauseSecond = await playerRequest(cookie, `/games/${secondId}/pause`, "POST");
    const resumeFirst = await playerRequest(cookie, `/games/${firstId}/join`, "POST");
    const resumedResult = await resumeFirst.json();

    expect(joinFirst.status).toBe(200);
    expect(firstResult).toMatchObject({ gameId: firstId, status: "playing" });
    expect(simultaneousJoin.status).toBe(409);
    expect(pauseFirst.status).toBe(200);
    expect(joinSecond.status).toBe(200);
    expect(pauseSecond.status).toBe(200);
    expect(resumeFirst.status).toBe(200);
    expect(resumedResult).toMatchObject({
      gameId: firstId,
      status: "playing",
      progress: { collectedTreasureIds: ["treasure-1"] },
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM game_participants WHERE player_id = (SELECT id FROM players WHERE email = ?)",
        )
        .get("player@example.com"),
    ).toEqual({ count: 2 });
  });

  it("prevents logging in from another device while playing, then resumes after pausing", async () => {
    now = Date.UTC(2026, 0, 1, 3);
    const gameId = await createDraft(
      "跨裝置恢復",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(gameId);
    const firstDeviceCookie = await login();
    expect((await playerRequest(firstDeviceCookie, `/games/${gameId}/join`, "POST")).status).toBe(
      200,
    );
    database
      .prepare("UPDATE game_participants SET progress_json = ? WHERE game_id = ?")
      .run('{"collectedTreasureIds":["treasure-2"]}', gameId);

    const requestResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com" }),
    });
    expect(requestResponse.status).toBe(202);
    const link = mailer.sent.at(-1);
    if (!link) {
      throw new Error("Expected a magic link");
    }
    const blockedLogin = await completeMagicLinkLogin(baseUrl, link.token, requestResponse.headers.get("X-Auth-Request-Token")!, link.requestId);
    const firstDeviceStillActive = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: firstDeviceCookie },
    });

    expect(blockedLogin.status).toBe(409);
    expect(firstDeviceStillActive.status).toBe(200);

    expect((await playerRequest(firstDeviceCookie, `/games/${gameId}/pause`, "POST")).status).toBe(
      200,
    );
    const replacementRequest = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com" }),
    });
    const replacementLink = mailer.sent.at(-1);
    if (!replacementLink) throw new Error("Expected a new magic link after pausing");
    const resumedLogin = await completeMagicLinkLogin(
      baseUrl,
      replacementLink.token,
      replacementRequest.headers.get("X-Auth-Request-Token")!,
      replacementLink.requestId,
    );
    const secondDeviceCookie = resumedLogin.headers.get("set-cookie")?.split(";")[0];
    if (!secondDeviceCookie) {
      throw new Error("Expected a resumed session cookie");
    }
    const resumedGame = await playerRequest(
      secondDeviceCookie,
      `/games/${gameId}/join`,
      "POST",
    );
    const resumedResult = await resumedGame.json();

    expect(resumedLogin.status).toBe(200);
    expect(resumedResult).toMatchObject({
      gameId,
      status: "playing",
      progress: { collectedTreasureIds: ["treasure-2"] },
    });
    expect(
      (
        await fetch(`${baseUrl}/auth/me`, {
          headers: { cookie: firstDeviceCookie },
        })
      ).status,
    ).toBe(401);
  });

  it("心跳逾時會保留回合進度，並允許新裝置登入接續回合", async () => {
    now = Date.UTC(2026, 0, 1, 3);
    const gameId = await createDraft(
      "回合心跳驗證",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(gameId);
    const firstDeviceCookie = await login();
    expect((await playerRequest(firstDeviceCookie, `/games/${gameId}/join`, "POST")).status).toBe(
      200,
    );
    database
      .prepare("UPDATE game_participants SET progress_json = ? WHERE game_id = ?")
      .run('{"collectedTreasureIds":["treasure-heartbeat"]}', gameId);

    now += 90_000;
    const heartbeat = await playerRequest(
      firstDeviceCookie,
      `/games/${gameId}/heartbeat`,
      "POST",
    );
    expect(heartbeat.status).toBe(200);

    now += 119_999;
    const requestResponse = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com" }),
    });
    expect(requestResponse.status).toBe(202);
    const link = mailer.sent.at(-1);
    if (!link) {
      throw new Error("Expected a magic link");
    }
    const earlyLogin = await completeMagicLinkLogin(baseUrl, link.token, requestResponse.headers.get("X-Auth-Request-Token")!, link.requestId);
    expect(earlyLogin.status).toBe(409);
    expect(
      (
        await fetch(`${baseUrl}/auth/me`, {
          headers: { cookie: firstDeviceCookie },
        })
      ).status,
    ).toBe(200);

    now += 1;
    const staleRequest = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com" }),
    });
    const staleLink = mailer.sent.at(-1);
    if (!staleLink) throw new Error("Expected a magic link after the heartbeat timeout");
    const staleLogin = await completeMagicLinkLogin(
      baseUrl,
      staleLink.token,
      staleRequest.headers.get("X-Auth-Request-Token")!,
      staleLink.requestId,
    );
    expect(staleLogin.status).toBe(200);
    const secondDeviceCookie = staleLogin.headers.get("set-cookie")?.split(";")[0];
    if (!secondDeviceCookie) {
      throw new Error("Expected a resumed session cookie");
    }
    const participant = database
      .prepare(
        "SELECT status, progress_json, device_token_hash FROM game_participants WHERE game_id = ?",
      )
      .get(gameId) as {
      status: string;
      progress_json: string;
      device_token_hash: string | null;
    };
    const game = database
      .prepare("SELECT status FROM games WHERE id = ?")
      .get(gameId) as { status: string };
    const resumedGame = await playerRequest(
      secondDeviceCookie,
      `/games/${gameId}/join`,
      "POST",
    );

    expect(participant).toMatchObject({
      status: "paused",
      progress_json: '{"collectedTreasureIds":["treasure-heartbeat"]}',
      device_token_hash: null,
    });
    expect(game.status).toBe("published");
    expect(resumedGame.status).toBe(200);
    expect(await resumedGame.json()).toMatchObject({
      gameId,
      status: "playing",
      progress: { collectedTreasureIds: ["treasure-heartbeat"] },
    });
    expect(
      (
        await fetch(`${baseUrl}/auth/me`, {
          headers: { cookie: firstDeviceCookie },
        })
      ).status,
    ).toBe(401);
  });

  it("requires pausing or exiting before logout and preserves progress across exit", async () => {
    now = Date.UTC(2026, 0, 1, 3);
    const gameId = await createDraft(
      "退出後恢復",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(gameId);
    const cookie = await login();
    expect((await playerRequest(cookie, `/games/${gameId}/join`, "POST")).status).toBe(200);
    database
      .prepare("UPDATE game_participants SET progress_json = ? WHERE game_id = ?")
      .run('{"collectedTreasureIds":["treasure-3"]}', gameId);

    const blockedLogout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(blockedLogout.status).toBe(409);

    const exitResponse = await playerRequest(cookie, `/games/${gameId}/exit`, "POST");
    const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    const replacementCookie = await login();
    const resumedResponse = await playerRequest(
      replacementCookie,
      `/games/${gameId}/join`,
      "POST",
    );
    const resumedResult = await resumedResponse.json();

    expect(exitResponse.status).toBe(200);
    expect(logoutResponse.status).toBe(204);
    expect(resumedResult).toMatchObject({
      gameId,
      status: "playing",
      progress: { collectedTreasureIds: ["treasure-3"] },
    });
  });

  it("blocks play before start, while paused, and permanently after ending; archives can only restore as ended", async () => {
    const gameId = await createDraft(
      "生命週期測試",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(gameId);
    const cookie = await login();

    expect((await playerRequest(cookie, `/games/${gameId}/join`, "POST")).status).toBe(409);
    now = Date.UTC(2026, 0, 1, 3);
    const joinResponse = await playerRequest(cookie, `/games/${gameId}/join`, "POST");
    expect(joinResponse.status).toBe(200);

    const pauseResponse = await adminRequest(`/admin/games/${gameId}/pause`, "POST");
    const blockedJoin = await playerRequest(cookie, `/games/${gameId}/join`, "POST");
    const resumeResponse = await adminRequest(`/admin/games/${gameId}/resume`, "POST");
    expect(pauseResponse.status).toBe(200);
    expect(blockedJoin.status).toBe(409);
    expect(resumeResponse.status).toBe(200);

    const endResponse = await adminRequest(`/admin/games/${gameId}/end`, "POST");
    const restoreResponse = await adminRequest(`/admin/games/${gameId}/restore`, "POST");
    const endedJoin = await playerRequest(cookie, `/games/${gameId}/join`, "POST");
    const adminList = await adminRequest("/admin/games", "GET");
    const adminResult = await adminList.json();

    expect(endResponse.status).toBe(200);
    expect(restoreResponse.status).toBe(200);
    expect(endedJoin.status).toBe(409);
    expect(adminResult.games).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: gameId, status: "ended" })]),
    );
  });

  it("does not permit resuming an administratively paused game after its scheduled end", async () => {
    const gameId = await createDraft(
      "逾時遊戲",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(gameId);
    now = Date.UTC(2026, 0, 1, 3);
    expect((await adminRequest(`/admin/games/${gameId}/pause`, "POST")).status).toBe(200);

    now = Date.UTC(2026, 0, 1, 4);
    const response = await adminRequest(`/admin/games/${gameId}/resume`, "POST");

    expect(response.status).toBe(409);
  });

  it("expires the seven-day archive, after which ended game data can be purged", async () => {
    const gameId = await createDraft(
      "封存期限",
      "2026-01-01T10:00:00+08:00",
      "2026-01-01T12:00:00+08:00",
    );
    await publishGame(gameId);
    const endedAt = now;
    expect((await adminRequest(`/admin/games/${gameId}/end`, "POST")).status).toBe(200);

    now = endedAt + 7 * 24 * 60 * 60 * 1000;
    const restoreResponse = await adminRequest(`/admin/games/${gameId}/restore`, "POST");
    const deleteResponse = await adminRequest(`/admin/games/${gameId}`, "DELETE", {
      confirmPermanentDeletion: true,
    });

    expect(restoreResponse.status).toBe(409);
    expect(deleteResponse.status).toBe(204);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM games WHERE id = ?").get(gameId),
    ).toEqual({ count: 0 });
  });
});
