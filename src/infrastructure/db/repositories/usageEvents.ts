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
  private stmtGetByClientModelDay = this.db.prepare(`
    SELECT
      model_id,
      DATE(created_at / 1000, 'unixepoch') as day,
      COUNT(*) as requests,
      SUM(request_tokens) as total_request_tokens,
      SUM(response_tokens) as total_response_tokens,
      AVG(latency_ms) as avg_latency_ms,
      SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
    FROM usage_events
    WHERE client_key_id = ? AND model_id = ? AND created_at >= ?
    GROUP BY model_id, day
    ORDER BY day DESC
  `);
  private stmtGetByProviderModelDay = this.db.prepare(`
    SELECT
      model_id,
      DATE(created_at / 1000, 'unixepoch') as day,
      COUNT(*) as requests,
      SUM(request_tokens) as total_request_tokens,
      SUM(response_tokens) as total_response_tokens,
      AVG(latency_ms) as avg_latency_ms,
      SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
    FROM usage_events
    WHERE provider_id = ? AND model_id = ? AND created_at >= ?
    GROUP BY model_id, day
    ORDER BY day DESC
  `);
  private stmtGetRecent = this.db.prepare(`
    SELECT * FROM usage_events
    ORDER BY created_at DESC
    LIMIT ?
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

  getByClientModelDay(clientKeyId: string, modelId: string, sinceMs: number): any[] {
    return this.stmtGetByClientModelDay.all(clientKeyId, modelId, sinceMs);
  }

  getByProviderModelDay(providerId: string, modelId: string, sinceMs: number): any[] {
    return this.stmtGetByProviderModelDay.all(providerId, modelId, sinceMs);
  }

  getRecent(limit: number): UsageEvent[] {
    return this.stmtGetRecent.all(limit) as UsageEvent[];
  }
}