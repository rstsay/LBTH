import { describe, expect, it, vi } from "vitest";
import { waitForAuthHandoff } from "../web/auth-handoff.js";

describe("Email 核准後登入等待", () => {
  it("短暫網路錯誤後繼續輪詢，直到核准並完成角色入口", async () => {
    let now = 0;
    const api = vi.fn()
      .mockRejectedValueOnce(new Error("暫時離線"))
      .mockResolvedValueOnce({ approved: false })
      .mockResolvedValueOnce({ approved: true, role: "player" });
    const wait = vi.fn(async (duration) => { now += duration; });
    const enterMode = vi.fn();

    const result = await waitForAuthHandoff({
      api,
      requestToken: "request-secret",
      expiresAt: 10_000,
      now: () => now,
      wait,
      enterMode,
    });

    expect(result.role).toBe("player");
    expect(api).toHaveBeenCalledTimes(3);
    expect(enterMode).toHaveBeenCalledWith("player");
  });

  it("三分鐘期限到期後回報重新登入", async () => {
    let now = 0;
    const api = vi.fn().mockResolvedValue({ approved: false });
    const wait = vi.fn(async (duration) => { now += duration; });

    await expect(waitForAuthHandoff({
      api,
      requestToken: "request-secret",
      expiresAt: 3_000,
      now: () => now,
      wait,
    })).rejects.toMatchObject({ code: "AUTH_HANDOFF_EXPIRED" });
  });

  it("核准後入口暫時載入失敗時重複交換並重試", async () => {
    let now = 0;
    const api = vi.fn().mockResolvedValue({ approved: true, role: "player" });
    const wait = vi.fn(async (duration) => { now += duration; });
    const enterMode = vi.fn()
      .mockRejectedValueOnce(new Error("入口暫時無法載入"))
      .mockResolvedValueOnce(undefined);

    const result = await waitForAuthHandoff({
      api,
      requestToken: "request-secret",
      expiresAt: 10_000,
      now: () => now,
      wait,
      enterMode,
    });

    expect(result.approved).toBe(true);
    expect(api).toHaveBeenCalledTimes(2);
    expect(enterMode).toHaveBeenCalledTimes(2);
  });
});
