import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuthApp,
  initializeAuthSchema,
  type MagicLinkSender,
} from "../src/auth.ts";

interface SentLink {
  email: string;
  url: string;
  token: string;
}

class FakeMagicLinkSender implements MagicLinkSender {
  readonly sent: SentLink[] = [];
  readonly requestTokens = new Map<string, string>();
  fail = false;

  async send(email: string, url: string): Promise<void> {
    if (this.fail) {
      throw new Error("mail transport unavailable");
    }
    const token = new URL(url).searchParams.get("token");
    if (!token) {
      throw new Error("Magic Link URL did not include its token");
    }
    this.sent.push({ email, url, token });
  }
}

describe("玩家 Email Magic Link 驗證", () => {
  let database: DatabaseSync;
  let mailer: FakeMagicLinkSender;
  let server: Server;
  let baseUrl: string;
  let now: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    mailer = new FakeMagicLinkSender();
    now = Date.UTC(2026, 0, 1);

    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      createToken: () => `test-token-${mailer.sent.length + 1}`,
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

  async function requestMagicLink(email: string): Promise<Response> {
    const response = await fetch(`${baseUrl}/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const link = mailer.sent.at(-1);
    const requestToken = response.headers.get("X-Auth-Request-Token");
    if (link && requestToken) mailer.requestTokens.set(link.token, requestToken);
    return response;
  }

  async function verify(token: string): Promise<Response> {
    const requestToken = mailer.requestTokens.get(token);
    const requestId = new URL(mailer.sent.find((link) => link.token === token)!.url)
      .searchParams.get("requestId");
    const approval = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, requestId }),
    });
    if (!approval.ok) return approval;
    return fetch(`${baseUrl}/auth/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestToken }),
    });
  }

  it("serves a landing page that documents the available API endpoints", async () => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("API 服務運作中");
    expect(body).toContain('href="/app"');
    expect(body).toContain('href="/leaderboard"');
    expect(body).toContain('href="/games"');
    expect(body).toContain("玩家與管理員網頁介面已就緒");
  });

  it("serves the frontend and exposes only the configured public Maps key", async () => {
    const appResponse = await fetch(`${baseUrl}/app`);
    const appScriptResponse = await fetch(`${baseUrl}/app/app.js`);
    const handoffScriptResponse = await fetch(`${baseUrl}/app/auth-handoff.js`);
    const configResponse = await fetch(`${baseUrl}/app/config.js`);
    const configBody = await configResponse.text();

    expect(appResponse.status).toBe(200);
    expect(await appResponse.text()).toContain("LBS 虛擬尋寶");
    expect(appScriptResponse.headers.get("cache-control")).toBe("no-store");
    expect(handoffScriptResponse.status).toBe(200);
    expect(handoffScriptResponse.headers.get("cache-control")).toBe("no-store");
    expect(configResponse.status).toBe(200);
    expect(configResponse.headers.get("cache-control")).toBe("no-store");
    expect(configBody).toContain('googleMapsApiKey: ""');
  });

  it("rejects malformed email addresses without sending a link", async () => {
    const response = await requestMagicLink("not-an-email");

    expect(response.status).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it("normalizes email before sending and does not create an account before verification", async () => {
    const response = await requestMagicLink("  Player@Example.COM  ");

    expect(response.status).toBe(202);
    expect(mailer.sent[0]?.email).toBe("player@example.com");
    expect(mailer.sent[0]?.url).toContain("/auth/verify?token=");
    expect(database.prepare("SELECT COUNT(*) AS count FROM players").get()).toEqual({
      count: 0,
    });
  });

  it("creates and verifies a player on first valid link use", async () => {
    await requestMagicLink("player@example.com");
    const sent = mailer.sent[0];
    if (!sent) {
      throw new Error("Expected a magic link to be sent");
    }

    const response = await verify(sent.token);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      player: {
        email: "player@example.com",
        emailVerified: true,
      },
    });
    expect(result.player.id).toEqual(expect.any(String));
    expect(result.player.anonymousCode).toEqual(expect.any(String));
    expect(database.prepare("SELECT COUNT(*) AS count FROM players").get()).toEqual({
      count: 1,
    });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("uses email confirmation only to approve login on the requesting device", async () => {
    const requestResponse = await requestMagicLink("handoff@example.com");
    const requestBody = await requestResponse.json();
    const link = mailer.sent[0];
    if (!link) throw new Error("Expected a magic link");
    const requestToken = requestResponse.headers.get("X-Auth-Request-Token");
    const requestId = new URL(link.url).searchParams.get("requestId");
    if (!requestId) throw new Error("Expected a request identifier in the email link");
    expect(new URL(link.url).searchParams.has("requestToken")).toBe(false);
    expect(link.url).not.toContain(requestToken);
    const confirmationUrl = new URL(`${baseUrl}/auth/verify`);
    confirmationUrl.searchParams.set("token", link.token);
    confirmationUrl.searchParams.set("requestId", requestId);
    const confirmationPage = await fetch(confirmationUrl);
    expect(confirmationPage.status).toBe(200);
    expect(await confirmationPage.text()).toContain('data-verification="player" hidden');
    const waiting = await fetch(`${baseUrl}/auth/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestToken }),
    });

    const approval = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token, requestId }),
    });
    const loginOnRequestingDevice = await fetch(`${baseUrl}/auth/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestToken }),
    });

    expect(requestResponse.status).toBe(202);
    expect(requestToken).toEqual(expect.any(String));
    expect(requestBody.requestToken).toBe(requestToken);
    expect(waiting.status).toBe(202);
    expect(waiting.headers.get("set-cookie")).toBeNull();
    expect(approval.status).toBe(200);
    expect(approval.headers.get("set-cookie")).toBeNull();
    expect(loginOnRequestingDevice.status).toBe(200);
    expect(loginOnRequestingDevice.headers.get("set-cookie")).toContain("player_session=");
  });

  it("expires an unconfirmed login request after three minutes", async () => {
    const requestResponse = await requestMagicLink("expired-handoff@example.com");
    const requestToken = requestResponse.headers.get("X-Auth-Request-Token");
    const link = mailer.sent.at(-1);
    if (!link) throw new Error("Expected a magic link");
    const requestId = new URL(link.url).searchParams.get("requestId");

    now += 3 * 60 * 1000;
    const approval = await fetch(`${baseUrl}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token, requestId }),
    });
    const completion = await fetch(`${baseUrl}/auth/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestToken }),
    });

    expect(approval.status).toBe(410);
    expect(completion.status).toBe(410);
    expect(completion.headers.get("set-cookie")).toBeNull();
  });

  it("authenticates the verified player using an HttpOnly session cookie", async () => {
    await requestMagicLink("player@example.com");
    const sent = mailer.sent[0];
    if (!sent) {
      throw new Error("Expected a magic link to be sent");
    }
    const loginResponse = await verify(sent.token);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a session cookie");
    }

    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie },
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.player.email).toBe("player@example.com");
  });

  it("revokes previous player session when a new Magic Link is verified", async () => {
    await requestMagicLink("player@example.com");
    const firstLink = mailer.sent[0];
    if (!firstLink) {
      throw new Error("Expected the first magic link");
    }
    const firstResponse = await verify(firstLink.token);
    const firstResult = await firstResponse.json();
    const firstCookie = firstResponse.headers.get("set-cookie")?.split(";")[0];
    if (!firstCookie) {
      throw new Error("Expected the first session cookie");
    }

    await requestMagicLink("player@example.com");
    const secondLink = mailer.sent[1];
    if (!secondLink) {
      throw new Error("Expected the second magic link");
    }
    const secondLogin = await verify(secondLink.token);
    const secondCookie = secondLogin.headers.get("set-cookie")?.split(";")[0];
    if (!secondCookie) {
      throw new Error("Expected the second session cookie");
    }

    const firstDeviceResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: firstCookie },
    });
    const secondDeviceResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: secondCookie },
    });

    expect(firstDeviceResponse.status).toBe(401);
    expect(secondDeviceResponse.status).toBe(200);
    expect(await secondDeviceResponse.json()).toMatchObject({
      player: {
        id: firstResult.player.id,
        email: "player@example.com",
      },
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM player_sessions WHERE revoked_at IS NULL")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps the current session valid until another Magic Link is successfully verified", async () => {
    await requestMagicLink("player@example.com");
    const link = mailer.sent[0];
    if (!link) {
      throw new Error("Expected a magic link");
    }
    const loginResponse = await verify(link.token);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a session cookie");
    }

    await requestMagicLink("player@example.com");
    const expiredLink = mailer.sent[1];
    if (!expiredLink) {
      throw new Error("Expected a second magic link");
    }
    now += 15 * 60 * 1000;
    const expiredLoginResponse = await verify(expiredLink.token);
    const currentSessionResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie },
    });

    expect(expiredLoginResponse.status).toBe(410);
    expect(currentSessionResponse.status).toBe(200);
  });

  it("does not revoke another player's active session", async () => {
    await requestMagicLink("first@example.com");
    const firstLink = mailer.sent[0];
    if (!firstLink) {
      throw new Error("Expected the first player's magic link");
    }
    const firstLogin = await verify(firstLink.token);
    const firstCookie = firstLogin.headers.get("set-cookie")?.split(";")[0];
    if (!firstCookie) {
      throw new Error("Expected the first player's session cookie");
    }

    await requestMagicLink("second@example.com");
    const secondLink = mailer.sent[1];
    if (!secondLink) {
      throw new Error("Expected the second player's magic link");
    }
    const secondLogin = await verify(secondLink.token);
    const secondCookie = secondLogin.headers.get("set-cookie")?.split(";")[0];
    if (!secondCookie) {
      throw new Error("Expected the second player's session cookie");
    }

    await requestMagicLink("first@example.com");
    const replacementLink = mailer.sent[2];
    if (!replacementLink) {
      throw new Error("Expected a replacement magic link");
    }
    await verify(replacementLink.token);

    const firstPlayerResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: firstCookie },
    });
    const secondPlayerResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: secondCookie },
    });

    expect(firstPlayerResponse.status).toBe(401);
    expect(secondPlayerResponse.status).toBe(200);
    expect((await secondPlayerResponse.json()).player.email).toBe("second@example.com");
  });

  it("repairs legacy duplicate active sessions before enforcing the single-session index", () => {
    const legacyDatabase = new DatabaseSync(":memory:");
    try {
      initializeAuthSchema(legacyDatabase);
      legacyDatabase.exec("DROP INDEX player_sessions_one_active_per_player_idx");
      legacyDatabase
        .prepare(
          `INSERT INTO players (id, email, anonymous_code, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("player-1", "player@example.com", "玩家-TEST", now, now);
      const insertSession = legacyDatabase.prepare(
        `INSERT INTO player_sessions (token_hash, player_id, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)`,
      );
      insertSession.run("session-hash-a", "player-1", now);
      insertSession.run("session-hash-b", "player-1", now + 1);

      initializeAuthSchema(legacyDatabase);

      expect(
        legacyDatabase
          .prepare("SELECT COUNT(*) AS count FROM player_sessions WHERE revoked_at IS NULL")
          .get(),
      ).toEqual({ count: 1 });
      expect(() =>
        insertSession.run("session-hash-c", "player-1", now + 2),
      ).toThrow();
    } finally {
      legacyDatabase.close();
    }
  });

  it("revokes the session on logout", async () => {
    await requestMagicLink("player@example.com");
    const sent = mailer.sent[0];
    if (!sent) {
      throw new Error("Expected a magic link to be sent");
    }
    const loginResponse = await verify(sent.token);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected a session cookie");
    }

    const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    const meResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie },
    });

    expect(logoutResponse.status).toBe(204);
    expect(meResponse.status).toBe(401);
  });

  it("maps normalized email variants to the same player identity", async () => {
    await requestMagicLink(" Player@Example.com ");
    const firstLink = mailer.sent[0];
    if (!firstLink) {
      throw new Error("Expected the first magic link");
    }
    const firstResponse = await verify(firstLink.token);
    const firstResult = await firstResponse.json();
    await requestMagicLink("player@example.COM");
    const secondLink = mailer.sent[1];
    if (!secondLink) {
      throw new Error("Expected the second magic link");
    }
    const secondResponse = await verify(secondLink.token);
    const secondResult = await secondResponse.json();

    expect(secondResult.player.id).toBe(firstResult.player.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM players").get()).toEqual({
      count: 1,
    });
  });

  it("rejects a link after the 15-minute expiration boundary", async () => {
    await requestMagicLink("player@example.com");
    const sent = mailer.sent[0];
    if (!sent) {
      throw new Error("Expected a magic link to be sent");
    }
    now += 15 * 60 * 1000;

    const response = await verify(sent.token);

    expect(response.status).toBe(410);
    expect(database.prepare("SELECT COUNT(*) AS count FROM players").get()).toEqual({
      count: 0,
    });
  });

  it("rejects a magic link after it has been used once", async () => {
    await requestMagicLink("player@example.com");
    const sent = mailer.sent[0];
    if (!sent) {
      throw new Error("Expected a magic link to be sent");
    }
    expect((await verify(sent.token)).status).toBe(200);

    const replay = await verify(sent.token);

    expect(replay.status).toBe(410);
    expect(database.prepare("SELECT COUNT(*) AS count FROM players").get()).toEqual({
      count: 1,
    });
  });

  it("does not allow login by supplying an email without a verified link", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com" }),
    });

    expect(response.status).toBe(404);
  });

  it("stores only a hash of the emailed one-time token", async () => {
    await requestMagicLink("player@example.com");
    const sent = mailer.sent[0];
    if (!sent) {
      throw new Error("Expected a magic link to be sent");
    }

    const rows = database.prepare("SELECT token_hash FROM magic_links").all() as Array<{
      token_hash: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(sent.token);
  });

  it("returns an explicit service error if email delivery fails", async () => {
    mailer.fail = true;

    const response = await requestMagicLink("player@example.com");

    expect(response.status).toBe(503);
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_links").get()).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM players").get()).toEqual({
      count: 0,
    });
  });
});
