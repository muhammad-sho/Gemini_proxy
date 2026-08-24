import { getDb } from "../connection.js";

export interface RequestLog {
  id: number;
  trace_id: string;
  client_key_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  method: string;
  path: string;
  request_headers: string;
  request_body: string | null;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  latency_ms: number | null;
  attempt_number: number;
  total_attempts: number;
  final_outcome: "success" | "error" | "timeout" | "aborted" | "no_keys";
  error_classification: string | null;
  timeline: string;
  created_at: number;
}

export interface RequestLogFilters {
  model?: string;
  outcome?: RequestLog["final_outcome"];
  query?: string;
  limit?: number;
  offset?: number;
}

export class RequestLogRepository {
  private db = getDb();

  private stmtInsert = this.db.prepare(`
    INSERT INTO request_logs (trace_id, client_key_id, provider_id, model_id, method, path, request_headers, request_body, response_status, response_headers, response_body, latency_ms, attempt_number, total_attempts, final_outcome, error_classification, timeline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  private stmtGetById = this.db.prepare("SELECT * FROM request_logs WHERE id = ?");
  private stmtGetFiltered = this.db.prepare(`
    SELECT * FROM request_logs
    WHERE (? IS NULL OR model_id = ?)
      AND (? IS NULL OR final_outcome = ?)
      AND (? IS NULL OR request_body LIKE ? OR response_body LIKE ?)
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  private stmtCountFiltered = this.db.prepare(`
    SELECT COUNT(*) as count FROM request_logs
    WHERE (? IS NULL OR model_id = ?)
      AND (? IS NULL OR final_outcome = ?)
      AND (? IS NULL OR request_body LIKE ? OR response_body LIKE ?)
  `);
  private stmtPrune = this.db.prepare(`
    DELETE FROM request_logs
    WHERE id NOT IN (
      SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ?
    )
  `);

  insert(log: Omit<RequestLog, "id" | "created_at">): number {
    const result = this.stmtInsert.run(
      log.trace_id,
      log.client_key_id,
      log.provider_id,
      log.model_id,
      log.method,
      log.path,
      log.request_headers,
      log.request_body,
      log.response_status,
      log.response_headers,
      log.response_body,
      log.latency_ms,
      log.attempt_number,
      log.total_attempts,
      log.final_outcome,
      log.error_classification,
      log.timeline
    );
    return result.lastInsertRowid as number;
  }

  findById(id: number): RequestLog | undefined {
    return this.stmtGetById.get(id) as RequestLog | undefined;
  }

  findFiltered(filters: RequestLogFilters): { logs: RequestLog[]; total: number } {
    const { model, outcome, query, limit = 50, offset = 0 } = filters;
    const searchTerm = query ? `%${query}%` : null;

    const logs = this.stmtGetFiltered.all(
      model ?? null, model ?? null,
      outcome ?? null, outcome ?? null,
      searchTerm, searchTerm, searchTerm,
      limit, offset
    ) as RequestLog[];

    const totalRow = this.stmtCountFiltered.get(
      model ?? null, model ?? null,
      outcome ?? null, outcome ?? null,
      searchTerm, searchTerm, searchTerm
    ) as { count: number };

    return { logs, total: totalRow.count };
  }

  prune(maxEntries: number): number {
    const result = this.stmtPrune.run(maxEntries);
    return result.changes;
  }
}