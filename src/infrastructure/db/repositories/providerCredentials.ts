import { getDb } from "../connection.js";
import { randomUUID } from "crypto";
import { encrypt, decrypt } from "../../../shared/crypto.js";
import { getConfig } from "../../../config/env.js";

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

  constructor() {
    const config = getConfig();
    if (config.encryptionKey) {
      this.encryptionKey = config.encryptionKey;
    }
  }

  private encryptKey(key: string): string {
    if (!this.encryptionKey) {
      throw new Error("Encryption key not configured");
    }
    return encrypt(key, this.encryptionKey);
  }

  private decryptKey(encrypted: string): string {
    if (!this.encryptionKey) {
      throw new Error("Encryption key not configured");
    }
    return decrypt(encrypted, this.encryptionKey);
  }

  findById(id: string): ProviderCredential | undefined {
    const row = this.stmtGetById.get(id) as any;
    if (!row) return undefined;
    return {
      ...row,
      allowed_models: JSON.parse(row.allowed_models ?? "[]"),
      allowed_groups: JSON.parse(row.allowed_groups ?? "[]")
    };
  }

  findAll(): ProviderCredential[] {
    const rows = this.stmtGetAll.all() as any[];
    return rows.map(row => ({
      ...row,
      allowed_models: JSON.parse(row.allowed_models ?? "[]"),
      allowed_groups: JSON.parse(row.allowed_groups ?? "[]")
    }));
  }

  findAllWithKeys(): ProviderCredentialWithSecret[] {
    const rows = this.db.prepare(
      "SELECT *, rowid AS seq FROM provider_credentials WHERE revoked_at IS NULL ORDER BY rowid ASC"
    ).all() as any[];
    return rows.map(row => ({
      ...row,
      allowed_models: JSON.parse(row.allowed_models ?? "[]"),
      allowed_groups: JSON.parse(row.allowed_groups ?? "[]"),
      apiKey: this.decryptKey(row.api_key_encrypted)
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
      throw new Error("Encryption key not configured (APP_ENCRYPTION_KEY)");
    }

    const id = `pc_${randomUUID()}`;
    const encrypted = this.encryptKey(apiKey);

    this.stmtInsert.run(
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
      apiKey
    };
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }
}