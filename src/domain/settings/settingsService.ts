import { z } from "zod";
import Database from "better-sqlite3";

/**
 * Runtime-tunable proxy behavior, editable from the dashboard Settings tab and
 * persisted as one JSON blob in the app_metadata table. Everything not listed
 * here is either a baked-in constant (transport limits) or deployment-level
 * environment configuration (ports, hosts, secrets).
 */

export const settingsSchema = z.object({
  keyFallbackAttempts: z.number().int().min(1).max(10),
  keyLoopDeadlineMs: z.number().int().min(1_000).max(600_000),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000),
  modelsCacheTtlHours: z.number().int().min(1).max(168),
  logBodyMaxBytes: z.number().int().min(1_024).max(5_242_880),
  maxLogEntries: z.number().int().min(50).max(100_000),
  rateLimitPerMinute: z.number().int().min(10).max(10_000),
  clientKeyRatePerMinute: z.number().int().min(0).max(100_000)
});

export type ProxySettings = z.infer<typeof settingsSchema>;

/** Patch schema for PUT /api/admin/v1/settings — every field optional. */
export const settingsUpdateSchema = settingsSchema.partial();
export type ProxySettingsPatch = z.infer<typeof settingsUpdateSchema>;

export const DEFAULT_SETTINGS: ProxySettings = {
  keyFallbackAttempts: 2,
  keyLoopDeadlineMs: 30_000,
  requestTimeoutMs: 60_000,
  modelsCacheTtlHours: 24,
  logBodyMaxBytes: 65_536,
  maxLogEntries: 1000,
  rateLimitPerMinute: 300,
  clientKeyRatePerMinute: 120
};

const METADATA_KEY = "settings";

export class SettingsService {
  private values: ProxySettings = { ...DEFAULT_SETTINGS };
  private stmtGet!: Database.Statement;
  private stmtUpsert!: Database.Statement;

  init(db: Database.Database): void {
    this.stmtGet = db.prepare("SELECT value FROM app_metadata WHERE key = ?");
    this.stmtUpsert = db.prepare(`
      INSERT INTO app_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')
    `);

    const row = this.stmtGet.get(METADATA_KEY) as { value: string } | undefined;
    if (!row) return;
    try {
      // Stored values were validated on write; still fall back to defaults
      // rather than refusing to boot if the blob is unreadable.
      const stored = settingsSchema.parse(JSON.parse(row.value));
      this.values = { ...DEFAULT_SETTINGS, ...stored };
    } catch {
      this.values = { ...DEFAULT_SETTINGS };
    }
  }

  all(): ProxySettings {
    return { ...this.values };
  }

  /** Validate merged result, persist it, and apply it live. */
  update(patch: ProxySettingsPatch): ProxySettings {
    const merged = settingsSchema.parse({ ...this.values, ...patch });
    this.stmtUpsert.run(METADATA_KEY, JSON.stringify(merged));
    this.values = merged;
    return { ...this.values };
  }

  resetToDefaultsForTests(): void {
    this.values = { ...DEFAULT_SETTINGS };
  }
}
