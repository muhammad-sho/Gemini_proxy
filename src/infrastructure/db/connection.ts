import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { dbPath } from "../../config/encryptionKey.js";

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  mkdirSync(dirname(dbPath()), { recursive: true });

  dbInstance = new Database(dbPath());
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  dbInstance.pragma("busy_timeout = 5000");

  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function runMigrations(db: Database.Database): void {
  const migrations = [
    // 001_initial_schema
    `CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    `CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS client_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      allowed_models TEXT NOT NULL DEFAULT '[]',
      allowed_groups TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      revoked_at INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('gemini', 'openai_compatible')),
      api_key_encrypted TEXT NOT NULL,
      base_url TEXT,
      allowed_models TEXT NOT NULL DEFAULT '[]',
      allowed_groups TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      revoked_at INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      provider TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    `CREATE TABLE IF NOT EXISTS model_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      raw_data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(provider_id, model_id)
    )`,

    `CREATE TABLE IF NOT EXISTS model_credential_state (
      model_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'cooling', 'disabled')),
      cooldown_until INTEGER,
      cooldown_reason TEXT,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      last_error_at INTEGER,
      last_error_message TEXT,
      PRIMARY KEY (model_id, credential_id)
    )`,

    `CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_key_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      request_tokens INTEGER,
      response_tokens INTEGER,
      latency_ms INTEGER,
      status_code INTEGER,
      error_message TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    `CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      client_key_id TEXT,
      provider_id TEXT,
      model_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_headers TEXT NOT NULL,
      request_body TEXT,
      response_status INTEGER,
      response_headers TEXT,
      response_body TEXT,
      latency_ms INTEGER,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      total_attempts INTEGER NOT NULL DEFAULT 1,
      final_outcome TEXT NOT NULL CHECK (final_outcome IN ('success', 'error', 'timeout', 'aborted', 'no_keys')),
      error_classification TEXT,
      timeline TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      ip_address TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    `CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_client_keys_hash ON client_keys(key_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_client_keys_revoked ON client_keys(revoked_at) WHERE revoked_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_provider_credentials_revoked ON provider_credentials(revoked_at) WHERE revoked_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_model_credential_state_cooldown ON model_credential_state(cooldown_until) WHERE cooldown_until IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_usage_events_client_model_day ON usage_events(client_key_id, model_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_events_provider_model_day ON usage_events(provider_id, model_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_request_logs_trace ON request_logs(trace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_request_logs_client_created ON request_logs(client_key_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_request_logs_model_created ON request_logs(model_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_request_logs_outcome_created ON request_logs(final_outcome, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at)`,

    // Model groups (pair-based: a group targets specific credential×model combos)
    `CREATE TABLE IF NOT EXISTS model_groups (
      group_name TEXT PRIMARY KEY,
      models TEXT NOT NULL DEFAULT '[]',
      description TEXT DEFAULT '',
      routing_strategy TEXT NOT NULL DEFAULT 'least_used' CHECK (routing_strategy IN ('least_used', 'fastest', 'smartest', 'cost_optimized')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,

    // v2: live model probing replaces the cache; groups become credential×model pairs
    `DROP TABLE IF EXISTS model_cache`,
    `DROP TABLE IF EXISTS models`,
    `DROP TABLE IF EXISTS model_groups`,
    `CREATE TABLE model_groups (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      routing_strategy TEXT NOT NULL DEFAULT 'least_used' CHECK (routing_strategy IN ('round_robin', 'least_used', 'fastest', 'smartest')),
      fallback_strategy TEXT CHECK (fallback_strategy IS NULL OR fallback_strategy IN ('round_robin', 'least_used', 'fastest', 'smartest')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,
    `CREATE TABLE model_group_pairs (
      group_id TEXT NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (group_id, credential_id, model_id)
    )`,
    `CREATE INDEX idx_model_group_pairs_target ON model_group_pairs(credential_id, model_id)`,
    `ALTER TABLE model_credential_state ADD COLUMN avg_latency_ms INTEGER`
  ];

  // Apply migrations
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`);
  for (let i = 0; i < migrations.length; i++) {
    const version = i + 1;
    const existing = db.prepare("SELECT version FROM schema_version WHERE version = ?").get(version);
    if (!existing) {
      db.exec(migrations[i]);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    }
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(version) as version FROM schema_version").get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}