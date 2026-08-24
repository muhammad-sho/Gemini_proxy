import { getDb } from "../connection.js";

export interface Model {
  id: string;
  name: string;
  display_name: string | null;
  provider: string;
  capabilities: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export class ModelRepository {
  private db = getDb();

  private stmtGetByName = this.db.prepare("SELECT * FROM models WHERE name = ?");
  private stmtGetById = this.db.prepare("SELECT * FROM models WHERE id = ?");
  private stmtGetAll = this.db.prepare("SELECT * FROM models ORDER BY name");
  private stmtUpsert = this.db.prepare(`
    INSERT INTO models (id, name, display_name, provider, capabilities, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      provider = excluded.provider,
      capabilities = excluded.capabilities,
      updated_at = excluded.updated_at
  `);
  private stmtDelete = this.db.prepare("DELETE FROM models WHERE id = ?");

  findByName(name: string): Model | undefined {
    return this.stmtGetByName.get(name) as Model | undefined;
  }

  findById(id: string): Model | undefined {
    return this.stmtGetById.get(id) as Model | undefined;
  }

  findAll(): Model[] {
    const rows = this.stmtGetAll.all() as Model[];
    return rows.map(row => ({
      ...row,
      capabilities: JSON.parse(row.capabilities as unknown as string)
    }));
  }

  upsert(
    id: string,
    name: string,
    displayName: string | null,
    provider: string,
    capabilities: Record<string, unknown>
  ): void {
    const now = Date.now();
    this.stmtUpsert.run(id, name, displayName, provider, JSON.stringify(capabilities), now, now);
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }
}