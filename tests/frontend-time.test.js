import { describe, expect, it } from "vitest";
import { activityTimeToIso } from "../web/time.js";

describe("管理員活動時區輸入", () => {
  it("converts local activity time to UTC using the selected timezone", () => {
    expect(activityTimeToIso("2026-01-01T09:30", "Asia/Taipei"))
      .toBe("2026-01-01T01:30:00.000Z");
    expect(activityTimeToIso("2026-01-01T09:30", "America/New_York"))
      .toBe("2026-01-01T14:30:00.000Z");
  });

  it("rejects nonexistent daylight-saving wall-clock times", () => {
    expect(() => activityTimeToIso("2026-03-08T02:30", "America/New_York"))
      .toThrow("此日期時間在所選時區不存在");
  });

  it("rejects invalid timezones and malformed or impossible dates", () => {
    expect(() => activityTimeToIso("2026-01-01T09:30", "invalid"))
      .toThrow("有效的 IANA 活動時區");
    expect(() => activityTimeToIso("2026-02-30T09:30", "Asia/Taipei"))
      .toThrow("有效的活動日期與時間");
  });
});
