import { createHmac } from "node:crypto";
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
}

class TestMagicLinkSender implements MagicLinkSender {
  readonly sent: SentLink[] = [];

  async send(email: string, url: string): Promise<void> {
    const token = new URL(url).searchParams.get("token");
    if (!token) {
      throw new Error("Magic Link URL did not include its token");
    }
    this.sent.push({ email, token });
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value: string): Buffer {
  let bits = "";
  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error("Invalid base32 value");
    }
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret: string, timestamp: number): string {
  const counter = Math.floor(timestamp / 30_000);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBytes)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

describe("管理員 Magic Link、TOTP 與角色授權", () => {
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
      adminTotpEncryptionKey: "test-encryption-key-at-least-32-chars",
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

  async function startAdminChallenge(email = "owner@example.com"): Promise<string> {
    const requestResponse = await requestAdminMagicLink(email);
    expect(requestResponse.status).toBe(202);
    const link = mailer.sent.at(-1);
    if (!link) {
      throw new Error("Expected an administrator Magic Link");
    }
    const verifyResponse = await fetch(`${baseUrl}/admin/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link.token }),
    });
    expect(verifyResponse.status).toBe(200);
    const result = await verifyResponse.json();
    return result.challengeToken as string;
  }

  async function enrollOwner(): Promise<{ cookie: string; adminId: string }> {
    const challengeToken = await startAdminChallenge();
    const enrollmentResponse = await fetch(`${baseUrl}/admin/auth/totp/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken }),
    });
    expect(enrollmentResponse.status).toBe(200);
    const enrollment = await enrollmentResponse.json();
    const code = totpCode(enrollment.secret, now);
    const confirmResponse = await fetch(`${baseUrl}/admin/auth/totp/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code }),
    });
    expect(confirmResponse.status).toBe(200);
    const cookie = confirmResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Expected an administrator session cookie");
    }
    const admin = database
      .prepare("SELECT id FROM administrators WHERE email = ?")
      .get("owner@example.com") as { id: string };
    return { cookie, adminId: admin.id };
  }

  it("requires a valid TOTP after email verification before granting admin access", async () => {
    const challengeToken = await startAdminChallenge();
    const deniedResponse = await fetch(`${baseUrl}/admin/games`);
    expect(deniedResponse.status).toBe(401);

    const enrollmentResponse = await fetch(`${baseUrl}/admin/auth/totp/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken }),
    });
    const { secret } = await enrollmentResponse.json();
    const rejectedCodeResponse = await fetch(`${baseUrl}/admin/auth/totp/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code: "invalid" }),
    });
    expect(rejectedCodeResponse.status).toBe(401);

    const confirmResponse = await fetch(`${baseUrl}/admin/auth/totp/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeToken, code: totpCode(secret, now) }),
    });
    const cookie = confirmResponse.headers.get("set-cookie")?.split(";")[0];
    const authorizedResponse = await fetch(`${baseUrl}/admin/games`, {
      headers: cookie ? { cookie } : {},
    });
    const storedTotpSecret = database
      .prepare(
        "SELECT totp_secret_encrypted FROM administrators WHERE email = ?",
      )
      .get("owner@example.com") as { totp_secret_encrypted: string };
    const replayChallenge = await startAdminChallenge();
    const replayResponse = await fetch(`${baseUrl}/admin/auth/totp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeToken: replayChallenge,
        code: totpCode(secret, now),
      }),
    });

    expect(confirmResponse.status).toBe(200);
    expect(confirmResponse.headers.get("set-cookie")).toContain("HttpOnly");
    expect(authorizedResponse.status).toBe(200);
    expect(storedTotpSecret.totp_secret_encrypted).not.toBe(secret);
    expect(replayResponse.status).toBe(401);

    now += 30_000;
    const nextChallenge = await startAdminChallenge();
    const secondFactorResponse = await fetch(
      `${baseUrl}/admin/auth/totp/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeToken: nextChallenge,
          code: totpCode(secret, now),
        }),
      },
    );
    expect(secondFactorResponse.status).toBe(200);
  });

  it("manages administrator roles, revokes disabled sessions, and audits without personal data", async () => {
    const owner = await enrollOwner();
    const lastOwnerDemotion = await fetch(
      `${baseUrl}/admin/administrators/${owner.adminId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: owner.cookie,
        },
        body: JSON.stringify({ role: "auditor" }),
      },
    );
    const lastOwnerDisable = await fetch(
      `${baseUrl}/admin/administrators/${owner.adminId}`,
      {
        method: "DELETE",
        headers: { cookie: owner.cookie },
      },
    );
    const secondOwnerResponse = await fetch(`${baseUrl}/admin/administrators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: owner.cookie,
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
        cookie: owner.cookie,
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

    const reviewerChallenge = await startAdminChallenge("reviewer@example.com");
    const reviewerEnrollmentResponse = await fetch(
      `${baseUrl}/admin/auth/totp/enroll`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeToken: reviewerChallenge }),
      },
    );
    const reviewerEnrollment = await reviewerEnrollmentResponse.json();
    const reviewerConfirm = await fetch(`${baseUrl}/admin/auth/totp/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeToken: reviewerChallenge,
        code: totpCode(reviewerEnrollment.secret, now),
      }),
    });
    const reviewerCookie = reviewerConfirm.headers.get("set-cookie")?.split(";")[0];
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
    const allowedReview = await fetch(`${baseUrl}/admin/games/anomalies`, {
      headers: reviewerCookie ? { cookie: reviewerCookie } : {},
    });
    const allowedAuditRead = await fetch(`${baseUrl}/admin/audit-logs`, {
      headers: reviewerCookie ? { cookie: reviewerCookie } : {},
    });

    const disableResponse = await fetch(
      `${baseUrl}/admin/administrators/${created.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: owner.cookie,
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
    expect(allowedReview.status).toBe(200);
    expect(allowedAuditRead.status).toBe(200);
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
