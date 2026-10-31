export class AuthHandoffExpiredError extends Error {
  constructor() {
    super("Email 核准逾時，請重新登入。");
    this.name = "AuthHandoffExpiredError";
    this.code = "AUTH_HANDOFF_EXPIRED";
  }
}

export async function waitForAuthHandoff({
  api,
  requestToken,
  expiresAt,
  now = Date.now,
  wait = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration)),
  enterMode = async () => {},
  onRetry = () => {},
  pollIntervalMs = 1500,
  requestTimeoutMs = 8000,
}) {
  while (now() < expiresAt) {
    const controller = new AbortController();
    const timeoutMs = Math.min(requestTimeoutMs, Math.max(1, expiresAt - now()));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await api("/auth/complete", {
        method: "POST",
        body: JSON.stringify({ requestToken }),
        signal: controller.signal,
      });
      if (result.approved) {
        await enterMode(result.role);
        return result;
      }
    } catch (error) {
      if (error?.code === "PLAYER_SESSION_ACTIVE" || error?.code === "PLAYER_GAME_SESSION_ACTIVE") {
        throw error;
      }
      if (error?.status === 410 || error?.code === "AUTH_HANDOFF_EXPIRED") {
        throw new AuthHandoffExpiredError();
      }
      onRetry(error);
    } finally {
      clearTimeout(timeout);
    }

    const remainingMs = expiresAt - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(pollIntervalMs, remainingMs));
  }
  throw new AuthHandoffExpiredError();
}
