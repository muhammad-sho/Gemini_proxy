import { getDb } from "../connection.js";

export interface AuditLog {
  id: number;
  admin_user_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: number;
}

export interface AuditLogFilters {
  action?: string;
  limit?: number;
  offset?: number;
}

export class AuditLogRepository {
  private db = getDb();

  private stmtInsert = this.db.prepare(`
    INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  private stmtFind = this.db.prepare(`
    SELECT * FROM audit_logs
    WHERE (? IS NULL OR action = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  private stmtCount = this.db.prepare(`
    SELECT COUNT(*) AS count FROM audit_logs
    WHERE (? IS NULL OR action = ?)
  `);
  /** Distinct actions for filter dropdowns. */
  private stmtActions = this.db.prepare("SELECT DISTINCT action FROM audit_logs ORDER BY action");

  record(log: Omit<AuditLog, "id" | "created_at">): number {
    const result = this.stmtInsert.run(
      log.admin_user_id,
      log.action,
      log.entity_type,
      log.entity_id,
      log.details,
      log.ip_address
    );
    return result.lastInsertRowid as number;
  }

  findFiltered(filters: AuditLogFilters): { logs: AuditLog[]; total: number } {
    const { action, limit = 50, offset = 0 } = filters;
    const logs = this.stmtFind.all(action ?? null, action ?? null, limit, offset) as AuditLog[];
    const { count } = this.stmtCount.get(action ?? null, action ?? null) as { count: number };
    return { logs, total: count };
  }

  distinctActions(): string[] {
    return (this.stmtActions.all() as Array<{ action: string }>).map(r => r.action);
  }
}
