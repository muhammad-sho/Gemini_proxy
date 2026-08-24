import { getDb } from "../connection.js";

export interface CachedModel {
  provider_id: string;
  model_id: string;
  raw_data: string;
  fetched_at: number;
}

export class ModelCacheRepository {
  private db = getDb();

  private stmtGetAll = this.db.prepare("SELECT * FROM model_cache ORDER BY model_id");
  private stmtUpsert = this.db.prepare(`
    INSERT INTO model_cache (provider_id, model_id, raw_data, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      raw_data = excluded.raw_data,
      fetched_at = excluded.fetched_at
  `);

  getAll(): CachedModel[] {
    return this.stmtGetAll.all() as CachedModel[];
  }

  setMany(entries: Array<{ providerId: string; modelId: string; rawData: string }>): void {
    const insertAll = this.db.transaction((rows: Array<{ providerId: string; modelId: string; rawData: string }>) => {
      for (const entry of rows) {
        this.stmtUpsert.run(entry.providerId, entry.modelId, entry.rawData, Date.now());
      }
    });
    insertAll(entries);
  }

  isFresh(providerId: string, ttlHours: number): boolean {
    const row = this.db.prepare("SELECT MIN(fetched_at) as min_fetched FROM model_cache WHERE provider_id = ?").get(providerId) as { min_fetched: number | null } | undefined;
    if (!row || row.min_fetched === null) return false;
    const ageHours = (Date.now() - row.min_fetched) / (1000 * 60 * 60);
    return ageHours < ttlHours;
  }
}