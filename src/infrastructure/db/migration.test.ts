import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "migrfix-"));

const { runMigrations, getSchemaVersion } = await import("./connection.js");

const scratch = new Database(":memory:");
const legacy = new Database(":memory:");

afterAll(() => {
  scratch.close();
  legacy.close();
  try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch { /* noop */ }
});

describe("migrations", () => {
  const total = runMigrations(scratch);

  it("reports the full schema version on a fresh database", () => {
    expect(total).toBeGreaterThan(0);
    expect(getSchemaVersion(scratch)).toBe(total);
  });

  it("migrates a pre-existing 'old' database to current without losing rows", () => {
    // Build an "installation from the previous release": everything except
    // the newest migration entries.
    const cutoff = Math.max(1, total - 3);
    runMigrations(legacy, cutoff);
    expect(getSchemaVersion(legacy)).toBe(cutoff);

    // Legacy data written against the old schema.
    legacy.prepare(
      "INSERT INTO client_keys (id, key_hash, label, allowed_models, allowed_groups) VALUES (?, ?, ?, ?, ?)"
    ).run("ck_old", "hash", "legacy", '["gemini-2.0-flash"]', '["old-group"]');
    legacy.prepare(
      "INSERT INTO model_credential_state (model_id, credential_id, state, use_count) VALUES (?, ?, 'ready', 7)"
    ).run("gemini-2.0-flash", "pc_old");

    // Complete the upgrade in place.
    runMigrations(legacy);
    expect(getSchemaVersion(legacy)).toBe(total);

    const key = legacy.prepare("SELECT * FROM client_keys WHERE id = 'ck_old'").get() as {
      allowed_groups: string;
      allowed_models: string;
    };
    expect(JSON.parse(key.allowed_groups)).toEqual(["old-group"]);
    expect(JSON.parse(key.allowed_models)).toEqual(["gemini-2.0-flash"]);

    const state = legacy.prepare(
      "SELECT state, use_count, avg_latency_ms FROM model_credential_state WHERE credential_id = 'pc_old'"
    ).get() as { state: string; use_count: number; avg_latency_ms: number | null };
    expect(state.state).toBe("ready");
    expect(state.use_count).toBe(7);
    // Column added by a newer migration defaults to NULL for existing rows.
    expect(state.avg_latency_ms).toBeNull();
  });
});
