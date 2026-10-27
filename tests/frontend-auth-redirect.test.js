import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const verificationScript = readFileSync(
  new URL("../web/verify.js", import.meta.url),
  "utf8",
);

async function submitVerification(role) {
  const channelMessages = [];
  const submitListeners = [];
  const submitButton = { disabled: false };
  const errorElement = { textContent: "" };
  const mainElement = { innerHTML: "" };
  const locationAssign = vi.fn();
  const storageSetItem = vi.fn();
  const form = {
    dataset: { verification: role },
    addEventListener: (_type, listener) => submitListeners.push(listener),
    querySelector: (selector) =>
      selector === "button[type=submit]" ? submitButton : errorElement,
  };
  const document = {
    querySelectorAll: () => [form],
    querySelector: (selector) =>
      selector === "main" ? mainElement : errorElement,
  };
  class TestBroadcastChannel {
    constructor(name) {
      this.name = name;
    }

    postMessage(message) {
      channelMessages.push({ name: this.name, message });
    }

    close() {}
  }
  class TestFormData {
    get() {
      return "single-use-token";
    }
  }
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ authenticated: true }),
  }));
  const window = {
    BroadcastChannel: TestBroadcastChannel,
    location: { assign: locationAssign },
    close: vi.fn(),
  };

  runInNewContext(verificationScript, {
    BroadcastChannel: TestBroadcastChannel,
    Date,
    document,
    fetch,
    FormData: TestFormData,
    localStorage: { setItem: storageSetItem },
    window,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { channelMessages, fetch, locationAssign, storageSetItem, mainElement };
}

describe("Email 確認後的登入接續", () => {
  it.each([
    ["player", "/auth/verify", "/app?login=success", "lbs-player-auth", "player-authenticated", "lbs-player-authenticated"],
    ["admin", "/admin/auth/verify", "/app?adminLogin=success", "lbs-admin-auth", "admin-authenticated", "lbs-admin-authenticated"],
  ])("%s 確認成功後導入工作區並通知原頁", async (role, endpoint, destination, channel, eventType, storageKey) => {
    const result = await submitVerification(role);

    expect(result.fetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "single-use-token", requestId: "single-use-token" }),
      }),
    );
    expect(result.locationAssign).not.toHaveBeenCalled();
    expect(result.mainElement.innerHTML).toContain("已確認");
    expect(result.channelMessages).toHaveLength(0);
    expect(result.storageSetItem).not.toHaveBeenCalled();
  });
});
