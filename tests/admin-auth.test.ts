import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuthApp,
  type MagicLinkSender,
} from "../src/auth.ts";

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
      throw new Error("Magic Link URL did not include its token");
    }
    this.sent.push({ email, token, requestId });
  }
}

describe("管理員 Magic Link、信任裝置與角色授權", () => {
  let database: DatabaseSync;
  let mailer: TestMagicLinkSender;
  let server: Server;
  let baseUrl: string;
  let now: number;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    mailer = new TestMagicLinkSender();
    now = Date.UTC(2026, 9, 1, 12);
    const app = createAuthApp({
      database,
      mailer,
      now: () => now,
      publicAppUrl: "https://hunt.example.test",
      adminBootstrapEmail: "owner@example.com",
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

  async function requestAdminMagicLink(email = "owner@example.com"): Promise<Response> {
    return fetch(`${baseUrl}/admin/auth/magic-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }

  async function verifyAdminMagicLink(email = "owner@example.com"): Promise<{
    sessionCookie: string;
    trustedDeviceCookie: string;
    adminId: string;
  }> {
    const requestResponse = await requestAdminMagicLink(email);
    const requestToken = requestResponse.headers.get("X-Auth-Request-Token");
    expect(requestResponse.status).toBe(202);
    const link = mailer.sent.at(-1);
    if (!link) {
      throw new Error("Expected an administrator Magic Link");
    }
    const approvalResponse = await fetch(`${baseUrl}/admin/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token, requestId: link.requestId }),
    });
    expect(approvalResponse.status).toBe(200);
    expect(approvalResponse.headers.get("set-cookie")).toBeNull();
    const verifyResponse = await fetch(`${baseUrl}/auth/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestToken }),
    });
    const cookies = verifyResponse.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!);
    const sessionCookie = cookies.find((value) => value.startsWith("admin_session="));
    const trustedDeviceCookie = cookies.find((value) =>
      value.startsWith("admin_trusted_device="),
    );
    if (!sessionCookie || !trustedDeviceCookie) {
      throw new Error("Expected session and trusted-device cookies");
    }
    const admin = database
      .prepare("SELECT id FROM administrators WHERE email = ?")
      .get(email) as { id: string };
    return { sessionCookie, trustedDeviceCookie, adminId: admin.id };
  }

  it("新裝置須完成 Email 確認，信任裝置登入不要求 TOTP", async () => {
    const deniedResponse = await fetch(`${baseUrl}/admin/games`);
    expect(deniedResponse.status).toBe(401);

    const owner = await verifyAdminMagicLink();
    const authorizedResponse = await fetch(`${baseUrl}/admin/games`, {
      headers: { cookie: owner.sessionCookie },
    });
    const trustedRequest = await fetch(`${baseUrl}/admin/auth/magic-links`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.trustedDeviceCookie,
      },
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    const trustedRequestBody = await trustedRequest.json();
    const deviceLoginResponse = await fetch(`${baseUrl}/admin/auth/device-login`, {
      method: "POST",
      headers: { cookie: owner.trustedDeviceCookie },
    });
    const deviceCookies = deviceLoginResponse.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!);
    const deviceSessionCookie = deviceCookies.find((value) =>
      value.startsWith("admin_session="),
    );
    const identityResponse = await fetch(`${baseUrl}/admin/auth/me`, {
      headers: deviceSessionCookie ? { cookie: deviceSessionCookie } : {},
    });

    expect(owner.sessionCookie).toContain("admin_session=");
    expect(owner.trustedDeviceCookie).toContain("admin_trusted_device=");
    expect(authorizedResponse.status).toBe(200);
    expect(trustedRequest.status).toBe(202);
    expect(trustedRequestBody).toMatchObject({ trustedDevice: true });
    expect(mailer.sent).toHaveLength(1);
    expect(deviceLoginResponse.status).toBe(200);
    expect(identityResponse.status).toBe(200);
    expect(await identityResponse.json()).toEqual({ admin: { role: "owner" } });
  });

  it("exposes the current administrator role only to an authenticated session", async () => {
    const anonymousResponse = await fetch(`${baseUrl}/admin/auth/me`);
    expect(anonymousResponse.status).toBe(401);

    const owner = await verifyAdminMagicLink();
    const identityResponse = await fetch(`${baseUrl}/admin/auth/me`, {
      headers: { cookie: owner.sessionCookie },
    });

    expect(identityResponse.status).toBe(200);
    expect(await identityResponse.json()).toEqual({ admin: { role: "owner" } });
  });

  it("manages administrator roles, revokes disabled sessions, and audits without personal data", async () => {
    const owner = await verifyAdminMagicLink();
    const lastOwnerDemotion = await fetch(
      `${baseUrl}/admin/administrators/${owner.adminId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: owner.sessionCookie,
        },
        body: JSON.stringify({ role: "auditor" }),
      },
    );
    const lastOwnerDisable = await fetch(
      `${baseUrl}/admin/administrators/${owner.adminId}`,
      {
        method: "DELETE",
        headers: { cookie: owner.sessionCookie },
      },
    );
    const secondOwnerResponse = await fetch(`${baseUrl}/admin/administrators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.sessionCookie,
      },
      body: JSON.stringify({ email: "co-owner@example.com", role: "owner" }),
    });
    expect(lastOwnerDemotion.status).toBe(409);
    expect(lastOwnerDisable.status).toBe(409);
    expect(secondOwnerResponse.status).toBe(201);

    const createResponse = await fetch(`${baseUrl}/admin/administrators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.sessionCookie,
      },
      body: JSON.stringify({
        email: "reviewer@example.com",
        role: "auditor",
        latitude: 121.5654,
      }),
    });
    const created = await createResponse.json();
    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({ role: "auditor", active: true });
    expect(JSON.stringify(created)).not.toContain("reviewer@example.com");

    const reviewer = await verifyAdminMagicLink("reviewer@example.com");
    const reviewerCookie = reviewer.sessionCookie;
    const deniedWrite = await fetch(`${baseUrl}/admin/administrators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(reviewerCookie ? { cookie: reviewerCookie } : {}),
      },
      body: JSON.stringify({ email: "another@example.com", role: "admin" }),
    });
    const deniedGameWrite = await fetch(`${baseUrl}/admin/games`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(reviewerCookie ? { cookie: reviewerCookie } : {}),
      },
      body: JSON.stringify({}),
    });
    const deniedPlayerLookup = await fetch(
      `${baseUrl}/admin/games/players?gameId=game-id&anonymousCode=PLAYER`,
      { headers: reviewerCookie ? { cookie: reviewerCookie } : {} },
    );
    const deniedProgressResetList = await fetch(
      `${baseUrl}/admin/games/progress-resets`,
      { headers: reviewerCookie ? { cookie: reviewerCookie } : {} },
    );
    const allowedReview = await fetch(`${baseUrl}/admin/games/anomalies`, {
      headers: reviewerCookie ? { cookie: reviewerCookie } : {},
    });
    const allowedAuditRead = await fetch(`${baseUrl}/admin/audit-logs`, {
      headers: reviewerCookie ? { cookie: reviewerCookie } : {},
    });
    const reviewerIdentity = await fetch(`${baseUrl}/admin/auth/me`, {
      headers: reviewerCookie ? { cookie: reviewerCookie } : {},
    });

    const disableResponse = await fetch(
      `${baseUrl}/admin/administrators/${created.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: owner.sessionCookie,
        },
        body: JSON.stringify({ active: false }),
      },
    );
    const disabledRequest = await fetch(`${baseUrl}/admin/games`, {
      headers: reviewerCookie ? { cookie: reviewerCookie } : {},
    });
    const auditRows = database
      .prepare(
        `SELECT actor_id, action, target_type, target_id, result, summary_json, created_at
         FROM admin_audit_log ORDER BY created_at`,
      )
      .all() as Array<{
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      result: string;
      summary_json: string;
      created_at: number;
    }>;
    const auditText = JSON.stringify(auditRows);

    expect(deniedWrite.status).toBe(403);
    expect(deniedGameWrite.status).toBe(403);
    expect(deniedPlayerLookup.status).toBe(403);
    expect(deniedProgressResetList.status).toBe(403);
    expect(allowedReview.status).toBe(200);
    expect(allowedAuditRead.status).toBe(200);
    expect(reviewerIdentity.status).toBe(200);
    expect(await reviewerIdentity.json()).toEqual({ admin: { role: "auditor" } });
    expect(disableResponse.status).toBe(200);
    expect(disabledRequest.status).toBe(401);
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
    expect(auditRows.some((row) => row.actor_id === owner.adminId)).toBe(true);
    expect(
      auditRows.some(
        (row) =>
          row.action === "GET /admin/games/anomalies" &&
          row.target_type === "anomalies",
      ),
    ).toBe(true);
    expect(
      auditRows.some(
        (row) =>
          row.action === "POST /admin/administrators" &&
          row.result === "failure" &&
          row.actor_id !== owner.adminId,
      ),
    ).toBe(true);
    expect(auditRows.every((row) => row.created_at >= now - 90 * 24 * 60 * 60 * 1000)).toBe(
      true,
    );
    expect(auditText).not.toContain("owner@example.com");
    expect(auditText).not.toContain("reviewer@example.com");
    expect(auditText).not.toContain("121.5654");
    expect(() =>
      database
        .prepare("UPDATE admin_audit_log SET action = 'tampered'")
        .run(),
    ).toThrow();
  });
});
