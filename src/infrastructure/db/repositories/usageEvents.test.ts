import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "usageret-"));

describe("UsageEventRepository retention", () => {
  let repo: import("./usageEvents.js").UsageEventRepository;

  beforeAll(async () => {
    const { getDb, runMigrations } = await import("../../db/connection.js");
    const db = getDb();
    runMigrations(db);
    const mod = await import("./usageEvents.js");
    repo = new mod.UsageEventRepository();
  });

  afterAll(() => {
    try { rmSync(process.env.DATA_DIR!, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it("prunes oldest entries beyond the retention cap", () => {
    for (let i = 0; i < 12; i++) {
      repo.record({
        client_key_id: "ck_test",
        provider_id: "pc_test",
        model_id: "m",
        request_tokens: null,
        response_tokens: null,
        latency_ms: i,
        status_code: 200,
        error_message: null
      });
    }
    expect(repo.prune(10)).toBeGreaterThanOrEqual(2);
    const recent = repo.getRecent(100);
    expect(recent.length).toBe(10);
    // Newest entries survive (highest ids kept)
    const ids = recent.map(r => r.id).sort((a, b) => a - b);
    for (let i = 3; i <= 12; i++) {
      expect(ids).toContain(i);
    }
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
  });

  it("prune is a no-op when under the cap", () => {
    expect(repo.prune(10_000)).toBe(0);
  });
});
