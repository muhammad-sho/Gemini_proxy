import { describe, it, expect } from "vitest";
import { encrypt, decrypt, hashApiKey, constantTimeEqual } from "./crypto.js";

describe("crypto", () => {
  it("encrypt/decrypt roundtrip", () => {
    const key = "test-encryption-key-with-enough-entropy";
    const secret = "AIzaSyFAKEKEY1234567890";
    const enc = encrypt(secret, key);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc, key)).toBe(secret);
  });

  it("decrypt with wrong key throws (GCM auth)", () => {
    const enc = encrypt("secret", "key-one");
    expect(() => decrypt(enc, "key-two")).toThrow();
  });

  it("hashApiKey is deterministic sha256 hex", () => {
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
    expect(hashApiKey("abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashApiKey("abc")).not.toBe(hashApiKey("abd"));
  });

  it("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
