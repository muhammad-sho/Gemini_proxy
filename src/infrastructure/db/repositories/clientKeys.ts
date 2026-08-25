import { getDb } from "../connection.js";
import { randomUUID } from "crypto";
import { hashApiKey, generateClientApiKey } from "../../../shared/crypto.js";
import { nowSec } from "../../../shared/time.js";

export interface ClientKey {
  id: string;
  key_hash: string;
  label: string;
  allowed_models: string[];
  allowed_groups: string[];
  created_at: number;
  revoked_at: number | null;
}

export interface ClientKeyWithSecret extends ClientKey {
  clientApiKey: string;
}

export class ClientKeyRepository {
  private db = getDb();

  private stmtGetByHash = this.db.prepare("SELECT * FROM client_keys WHERE key_hash = ? AND revoked_at IS NULL");
  private stmtGetById = this.db.prepare("SELECT * FROM client_keys WHERE id = ?");
  private stmtGetAll = this.db.prepare("SELECT id, label, allowed_models, allowed_groups, created_at, revoked_at FROM client_keys ORDER BY created_at DESC");
  private stmtInsert = this.db.prepare(`
    INSERT INTO client_keys (id, key_hash, label, allowed_models, allowed_groups)
    VALUES (?, ?, ?, ?, ?)
  `);
  private stmtDelete = this.db.prepare("DELETE FROM client_keys WHERE id = ?");
  private stmtUpdate = this.db.prepare(`
    UPDATE client_keys
    SET label = ?, allowed_models = ?, allowed_groups = ?
    WHERE id = ?
  `);

  private parseRow(row: any): ClientKey {
    return {
      ...row,
      allowed_models: JSON.parse(row.allowed_models ?? "[]"),
      allowed_groups: JSON.parse(row.allowed_groups ?? "[]")
    };
  }

  findByHash(keyHash: string): ClientKey | undefined {
    const row = this.stmtGetByHash.get(keyHash);
    return row ? this.parseRow(row) : undefined;
  }

  findById(id: string): ClientKey | undefined {
    const row = this.stmtGetById.get(id);
    return row ? this.parseRow(row) : undefined;
  }

  findAll(): ClientKey[] {
    return (this.stmtGetAll.all() as unknown[]).map(row => this.parseRow(row));
  }

  create(label: string, allowedModels: string[] = [], allowedGroups: string[] = []): ClientKeyWithSecret {
    const clientApiKey = generateClientApiKey();
    const keyHash = hashApiKey(clientApiKey);
    const id = `ck_${randomUUID()}`;

    this.stmtInsert.run(
      id,
      keyHash,
      label,
      JSON.stringify(allowedModels),
      JSON.stringify(allowedGroups)
    );

    return {
      id,
      key_hash: keyHash,
      label,
      allowed_models: allowedModels,
      allowed_groups: allowedGroups,
      created_at: nowSec(),
      revoked_at: null,
      clientApiKey
    };
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  update(id: string, fields: { label: string; allowed_models: string[]; allowed_groups: string[] }): boolean {
    const result = this.stmtUpdate.run(
      fields.label,
      JSON.stringify(fields.allowed_models),
      JSON.stringify(fields.allowed_groups),
      id
    );
    return result.changes > 0;
  }
}