import { describe, it, expect } from "vitest";
import { validateEnv } from "./validation.js";

const base = {
  ADMIN_PORT: "1234",
  KEY_FALLBACK_ATTEMPTS: "3"
};

describe("validateEnv", () => {
  it("maps uppercase env to camelCase config with deployment defaults", () => {
    const c = validateEnv(base);
    expect(c.adminPort).toBe(1234);
    expect(c.geminiPort).toBe(18770);
    expect(c.openaiPort).toBe(18771);
    expect(c.gatewayHost).toBe("0.0.0.0");
    expect(c.adminHost).toBe("127.0.0.1");
    expect(c.trustProxy).toBe(false);
    expect(c.nodeEnv).toBe("development");
  });

  it("no longer accepts removed app-tuning variables (they live in dashboard Settings)", () => {
    // Unknown keys are ignored by the schema; tuning moved to runtime settings.
    const c = validateEnv(base);
    expect((c as unknown as Record<string, unknown>).keyFallbackAttempts).toBeUndefined();
  });

  it("TRUST_PROXY string parsing: 'true' true, 'false'/unset false (not boolean-coerced)", () => {
    expect(validateEnv({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(validateEnv({ ...base, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(validateEnv(base).trustProxy).toBe(false);
  });

  it("rejects non-numeric admin port", () => {
    expect(() => validateEnv({ ...base, ADMIN_PORT: "nope" })).toThrow(/ADMIN_PORT/);
  });

  it("accepts a valid LOG_LEVEL and rejects unknown ones", () => {
    expect(validateEnv({ ...base, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(validateEnv(base).logLevel).toBeUndefined();
    expect(() => validateEnv({ ...base, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});
