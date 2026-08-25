import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { DEFAULT_SETTINGS, SettingsService, settingsSchema } from "./settingsService.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  )`);
  return db;
}

describe("SettingsService", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("returns defaults when nothing was persisted", () => {
    const s = new SettingsService();
    s.init(db);
    expect(s.all()).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a patch immediately and persists it for the next init", () => {
    const s = new SettingsService();
    s.init(db);

    const updated = s.update({ keyFallbackAttempts: 4, maxLogEntries: 250 });
    expect(updated.keyFallbackAttempts).toBe(4);
    expect(s.all().keyFallbackAttempts).toBe(4);
    // Untouched fields keep defaults
    expect(updated.keyLoopDeadlineMs).toBe(DEFAULT_SETTINGS.keyLoopDeadlineMs);

    const reloaded = new SettingsService();
    reloaded.init(db);
    expect(reloaded.all()).toMatchObject({ keyFallbackAttempts: 4, maxLogEntries: 250 });
  });

  it("rejects out-of-range values without changing state", () => {
    const s = new SettingsService();
    s.init(db);
    expect(() => s.update({ keyFallbackAttempts: 99 })).toThrow();
    expect(() => s.update({ requestTimeoutMs: 5 })).toThrow(); // below min
    expect(s.all()).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults when stored data is corrupt", () => {
    db.prepare("INSERT INTO app_metadata (key, value) VALUES ('settings', '{not json')").run();
    const s = new SettingsService();
    s.init(db);
    expect(s.all()).toEqual(DEFAULT_SETTINGS);
  });

  it("schema bounds match documented ranges", () => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, logBodyMaxBytes: 1023 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, modelsCacheTtlHours: 169 }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS }).success).toBe(true);
  });
});
