import { describe, it, expect } from "vitest";
import { classifyUpstreamError } from "./adapter.js";

describe("classifyUpstreamError (gemini)", () => {
  it("401 -> invalid_key", () => {
    expect(classifyUpstreamError(401, {}, "gemini")).toBe("invalid_key");
  });

  it("400 with API_KEY_INVALID reason -> invalid_key", () => {
    const body = { error: { message: "API key not valid", status: "INVALID_ARGUMENT" } };
    expect(classifyUpstreamError(400, body, "gemini")).toBe("invalid_key");
  });

  it("429 generic -> rate_limit", () => {
    expect(classifyUpstreamError(429, { error: { message: "Resource exhausted" } }, "gemini")).toBe("rate_limit");
  });

  it("429 per-day evidence -> daily_quota", () => {
    const body = { error: { message: "Generate requests per day limit", details: [] } };
    expect(classifyUpstreamError(429, body, "gemini")).toBe("daily_quota");
  });

  it("5xx -> transient", () => {
    expect(classifyUpstreamError(503, null, "gemini")).toBe("transient");
    expect(classifyUpstreamError(408, null, "gemini")).toBe("transient");
  });

  it("other 4xx -> permanent", () => {
    expect(classifyUpstreamError(404, null, "gemini")).toBe("permanent");
  });
});
