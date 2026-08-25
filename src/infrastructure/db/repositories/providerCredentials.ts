import { getDb } from "../connection.js";
import { randomUUID } from "crypto";
import { encrypt, decrypt } from "../../../shared/crypto.js";
import { getEncryptionKey } from "../../../config/encryptionKey.js";

export interface ProviderCredential {
  id: string;
  label: string;
  provider: "gemini" | "openai_compatible";
  api_key_encrypted: string;
  base_url: string | null;
  allowed_models: string[];
  allowed_groups: string[];
  created_at: number;
  revoked_at: number | null;
}

export interface ProviderCredentialWithSecret extends ProviderCredential {
  apiKey: string;
  /** Insertion order (rowid) — keeps candidate ordering deterministic. */
  seq: number;
}

export class ProviderCredentialRepository {
  private db = getDb();
  private encryptionKey: string | null = null;

  private stmtGetById = this.db.prepare("SELECT * FROM provider_credentials WHERE id = ? AND revoked_at IS NULL");
  private stmtGetAll = this.db.prepare("SELECT id, label, provider, base_url, allowed_models, allowed_groups, created_at, revoked_at FROM provider_credentials WHERE revoked_at IS NULL ORDER BY created_at DESC");
  private stmtInsert = this.db.prepare(`
    INSERT INTO provider_credentials (id, label, provider, api_key_encrypted, base_url, allowed_models, allowed_groups)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  private stmtDelete = this.db.prepare("DELETE FROM provider_credentials WHERE id = ?");
  private stmtUpdate = this.db.prepare(`
    UPDATE provider_credentials
    SET label = COALESCE(?, label),
        base_url = COALESCE(?, base_url),
        allowed_models = COALESCE(?, allowed_models),
        allowed_groups = COALESCE(?, allowed_groups)
    WHERE id = ? AND revoked_at IS NULL
  `);

  constructor() {
    // Key is generated on first use inside the data directory; no config needed.
    this.encryptionKey = getEncryptionKey();
  }

  private encryptKey(key: string): string {
    if (!this.encryptionKey) {
      throw new Error("Encryption key unavailable — check write access to the data directory");
    }
    return encrypt(key, this.encryptionKey);
  }

  private decryptKey(encrypted: string): string {
    if (!this.encryptionKey) {
      throw new Error("Encryption key unavailable — check write access to the data directory");
    }
    return decrypt(encrypted, this.encryptionKey);
  }

  private parseRow(row: Record<string, unknown>): ProviderCredential {
    return {
      id: String(row.id),
      label: String(row.label),
      provider: row.provider === "openai_compatible" ? "openai_compatible" : "gemini",
      api_key_encrypted: String(row.api_key_encrypted),
      base_url: (row.base_url as string | null) ?? null,
      allowed_models: JSON.parse(String(row.allowed_models ?? "[]")) as string[],
      allowed_groups: JSON.parse(String(row.allowed_groups ?? "[]")) as string[],
      created_at: Number(row.created_at),
      revoked_at: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at)
    };
  }

  findById(id: string): ProviderCredential | undefined {
    const row = this.stmtGetById.get(id) as Record<string, unknown> | undefined;
    return row ? this.parseRow(row) : undefined;
  }

  findAll(): ProviderCredential[] {
    return (this.stmtGetAll.all() as Array<Record<string, unknown>>).map(row => this.parseRow(row));
  }

  findAllWithKeys(): ProviderCredentialWithSecret[] {
    const rows = this.db.prepare(
      "SELECT *, rowid AS seq FROM provider_credentials WHERE revoked_at IS NULL ORDER BY rowid ASC"
    ).all() as Array<Record<string, unknown>>;
    return rows.map(row => ({
      ...this.parseRow(row),
      apiKey: this.decryptKey(String(row.api_key_encrypted)),
      seq: Number(row.seq)
    }));
  }

  create(
    label: string,
    provider: "gemini" | "openai_compatible",
    apiKey: string,
    baseUrl: string | null,
    allowedModels: string[] = [],
    allowedGroups: string[] = []
  ): ProviderCredentialWithSecret {
    if (!this.encryptionKey) {
      throw new Error("Encryption key unavailable — check write access to the data directory");
    }

    const id = `pc_${randomUUID()}`;
    const encrypted = this.encryptKey(apiKey);

    const result = this.stmtInsert.run(
      id,
      label,
      provider,
      encrypted,
      baseUrl,
      JSON.stringify(allowedModels),
      JSON.stringify(allowedGroups)
    );

    return {
      id,
      label,
      provider,
      api_key_encrypted: encrypted,
      base_url: baseUrl,
      allowed_models: allowedModels,
      allowed_groups: allowedGroups,
      created_at: Date.now(),
      revoked_at: null,
      apiKey,
      seq: Number(result.lastInsertRowid)
    };
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  update(
    id: string,
    fields: Partial<Pick<ProviderCredential, "label" | "base_url" | "allowed_models" | "allowed_groups">>
  ): boolean {
    const result = this.stmtUpdate.run(
      fields.label ?? null,
      fields.base_url ?? null,
      fields.allowed_models ? JSON.stringify(fields.allowed_models) : null,
      fields.allowed_groups ? JSON.stringify(fields.allowed_groups) : null,
      id
    );
    return result.changes > 0;
  }
}