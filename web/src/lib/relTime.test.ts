import { describe, it, expect } from "vitest";
import { relTime } from "./relTime.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");

describe("relTime", () => {
  it("says just now under a minute", () => {
    expect(relTime(NOW / 1000 - 30, NOW)).toBe("just now");
    expect(relTime(NOW / 1000, NOW)).toBe("just now");
  });

  it("counts minutes and hours", () => {
    expect(relTime(NOW / 1000 - 5 * 60, NOW)).toBe("5m ago");
    expect(relTime(NOW / 1000 - 3 * 3600, NOW)).toBe("3h ago");
  });

  it("counts days beyond a day", () => {
    expect(relTime(NOW / 1000 - 2 * 86400, NOW)).toBe("2d ago");
  });
});
