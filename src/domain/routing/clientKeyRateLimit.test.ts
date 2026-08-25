import { describe, it, expect, beforeEach } from "vitest";
import { allowClientKeyRequest, resetClientKeyBuckets } from "./clientKeyRateLimit.js";

describe("client-key rate limiter", () => {
  const NOW = 1_000_000_000;

  beforeEach(() => resetClientKeyBuckets());

  it("allows everything when the limit is 0 (disabled)", () => {
    for (let i = 0; i < 500; i++) {
      expect(allowClientKeyRequest("k", 0, NOW)).toBe(true);
    }
  });

  it("counts requests per key within a one-minute window", () => {
    expect(allowClientKeyRequest("k", 3, NOW)).toBe(true);
    expect(allowClientKeyRequest("k", 3, NOW + 1)).toBe(true);
    expect(allowClientKeyRequest("k", 3, NOW + 2)).toBe(true);
    expect(allowClientKeyRequest("k", 3, NOW + 3)).toBe(false);
    // other keys are independent
    expect(allowClientKeyRequest("other", 3, NOW + 4)).toBe(true);
  });

  it("opens a fresh window after the minute elapses", () => {
    expect(allowClientKeyRequest("k", 1, NOW)).toBe(true);
    expect(allowClientKeyRequest("k", 1, NOW + 30_000)).toBe(false);
    expect(allowClientKeyRequest("k", 1, NOW + 60_001)).toBe(true);
  });
});
