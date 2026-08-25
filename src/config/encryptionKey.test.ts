import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dataDir = mkdtempSync(join(tmpdir(), "enckey-"));
process.env.DATA_DIR = dataDir;

const { getEncryptionKey } = await import("./encryptionKey.js");

afterAll(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("encryption key resolution", () => {
  it("generates a 32-byte base64 key on first use and persists it", () => {
    const key = getEncryptionKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    const file = join(dataDir, "encryption.key");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(key);
  });

  it("reuses the persisted key on subsequent calls", () => {
    // Same module instance is memoized; a second process would read the file.
    const key = getEncryptionKey();
    expect(key).toBe(getEncryptionKey());
    expect(key.length).toBe(44);
  });
});
