import { describe, it, expect } from "vitest";
import { cooldownFor } from "./cooldown.js";

describe("cooldownFor", () => {
  it("invalid_key -> 60s invalid_key policy", () => {
    const p = cooldownFor("invalid_key");
    expect(p.kind).toBe("invalid_key");
    expect(p.durationMs).toBe(60_000);
  });

  it("transient classification -> 60s upstream_error", () => {
    const p = cooldownFor("transient");
    expect(p.kind).toBe("transient");
    expect(p.durationMs).toBe(60_000);
  });

  it("direct daily_quota classification -> daily_quota until midnight", () => {
    const p = cooldownFor("daily_quota");
    expect(p.kind).toBe("daily_quota");
    expect(p.reason).toBe("daily_quota");
    expect(p.durationMs).toBeGreaterThan(0);
    expect(p.durationMs).toBeLessThanOrEqual(24 * 3600_000);
  });

  it("rate_limit without daily evidence -> transient", () => {
    const p = cooldownFor("rate_limit", { message: "Resource has been exhausted (e.g. check quota)." });
    expect(p.kind).toBe("transient");
    expect(p.reason).toBe("rate_limit");
  });

  it("rate_limit with 'per day' in message -> daily_quota until midnight", () => {
    const p = cooldownFor("rate_limit", { message: "Generate requests per day limit reached" });
    expect(p.kind).toBe("daily_quota");
    expect(p.durationMs).toBeGreaterThan(0);
    expect(p.durationMs).toBeLessThanOrEqual(24 * 3600_000);
  });

  it("rate_limit with rpd token -> daily_quota", () => {
    const p = cooldownFor("rate_limit", { message: "limit: 10 RPD" });
    expect(p.kind).toBe("daily_quota");
  });

  it("QuotaFailure detail containing perDay -> daily_quota even with generic message", () => {
    const p = cooldownFor("rate_limit", {
      message: "Resource exhausted",
      quotaDetails: [{ "@type": "type.googleapis/google.rpc.QuotaFailure", violations: "PerDay" }]
    });
    expect(p.kind).toBe("daily_quota");
  });

  it("RPM exhaustion must NOT trigger daily quota", () => {
    const p = cooldownFor("rate_limit", { message: "Requests per minute limit reached" });
    expect(p.kind).toBe("transient");
  });

  it("permanent/unknown -> no cooldown", () => {
    expect(cooldownFor("permanent").kind).toBe("none");
    expect(cooldownFor("unknown").kind).toBe("none");
  });
});
