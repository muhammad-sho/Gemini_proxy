import { describe, it, expect } from "vitest";
import { validateEnv } from "./validation.js";

const base = {
  SETUP_TOKEN: "tok",
  PORT: "1234",
  DB_PATH: "/tmp/x.db",
  KEY_FALLBACK_ATTEMPTS: "3"
};

describe("validateEnv", () => {
  it("maps uppercase env to camelCase config", () => {
    const c = validateEnv(base);
    expect(c.port).toBe(1234);
    expect(c.dbPath).toBe("/tmp/x.db");
    expect(c.setupToken).toBe("tok");
    expect(c.keyFallbackAttempts).toBe(3);
    expect(c.nodeEnv).toBe("development");
  });

  it("rejects missing setup token", () => {
    expect(() => validateEnv({})).toThrow(/SETUP_TOKEN/);
  });

  it("TRUST_PROXY string parsing: 'true' true, 'false'/unset false (not boolean-coerced)", () => {
    expect(validateEnv({ ...base, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(validateEnv({ ...base, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(validateEnv(base).trustProxy).toBe(false);
  });

  it("rejects non-numeric port", () => {
    expect(() => validateEnv({ ...base, PORT: "nope" })).toThrow(/PORT/);
  });
});
