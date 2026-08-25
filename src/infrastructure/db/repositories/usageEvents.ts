import { getDb } from "../connection.js";

export interface UsageEvent {
  id: number;
  client_key_id: string;
  provider_id: string;
  model_id: string;
  request_tokens: number | null;
  response_tokens: number | null;
  latency_ms: number | null;
  status_code: number | null;
  error_message: string | null;
  created_at: number;
}

export class UsageEventRepository {
  private db = getDb();

  private stmtInsert = this.db.prepare(`
    INSERT INTO usage_events (client_key_id, provider_id, model_id, request_tokens, response_tokens, latency_ms, status_code, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private stmtGetRecent = this.db.prepare(`
    SELECT * FROM usage_events
    ORDER BY created_at DESC
    LIMIT ?
  `);
  private stmtAggregate = this.db.prepare(`
    SELECT model_id,
           COUNT(*) AS requests,
           COALESCE(SUM(request_tokens), 0) AS prompt_tokens,
           COALESCE(SUM(response_tokens), 0) AS completion_tokens
    FROM usage_events
    WHERE created_at >= ?
    GROUP BY model_id
    ORDER BY requests DESC
    LIMIT 100
  `);
  private stmtPrune = this.db.prepare(`
    DELETE FROM usage_events
    WHERE id NOT IN (
      SELECT id FROM usage_events ORDER BY created_at DESC, id DESC LIMIT ?
    )
  `);

  record(event: Omit<UsageEvent, "id" | "created_at">): number {
    const result = this.stmtInsert.run(
      event.client_key_id,
      event.provider_id,
      event.model_id,
      event.request_tokens,
      event.response_tokens,
      event.latency_ms,
      event.status_code,
      event.error_message
    );
    return result.lastInsertRowid as number;
  }

  getRecent(limit: number): UsageEvent[] {
    return this.stmtGetRecent.all(limit) as UsageEvent[];
  }

  /** Retention cap shared with request logs (settings.maxLogEntries). */
  prune(maxEntries: number): number {
    return this.stmtPrune.run(maxEntries).changes;
  }

  aggregateByModel(sinceSec: number): Array<{
    modelId: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }> {
    return (this.stmtAggregate.all(sinceSec) as Array<{
      model_id: string;
      requests: number;
      prompt_tokens: number;
      completion_tokens: number;
    }>).map(r => ({
      modelId: r.model_id,
      requests: r.requests,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens
    }));
  }
}