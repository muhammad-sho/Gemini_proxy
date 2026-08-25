import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const KEY_FILE = "encryption.key";
let cached: string | null = null;

/** All app data lives in one folder: ./data beside the app/compose file. */
export function dataDir(): string {
  // Internal override for containers (Docker mounts the volume at /data).
  return process.env.DATA_DIR ?? "./data";
}

export function dbPath(): string {
  return join(dataDir(), "gemini-proxy.db");
}

/**
 * AES-256-GCM key protecting provider API keys at rest. Generated once on
 * first use and stored inside the data directory — no configuration needed.
 * Backing up the data directory backs up both the database and this key.
 */
export function getEncryptionKey(): string {
  if (cached) return cached;

  const keyPath = join(dataDir(), KEY_FILE);
  if (existsSync(keyPath)) {
    const existing = readFileSync(keyPath, "utf8").trim();
    if (existing.length > 0) {
      cached = existing;
      return cached;
    }
  }

  const generated = randomBytes(32).toString("base64");
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(keyPath, generated + "\n", { mode: 0o600 });
  cached = generated;
  return cached;
}
