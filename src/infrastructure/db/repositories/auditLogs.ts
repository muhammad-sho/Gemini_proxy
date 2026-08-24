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

export class AuditLogRepository {
  private db = getDb();

  private stmtInsert = this.db.prepare(`
    INSERT INTO audit_logs (admin_user_id, action, entity_type, entity_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

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
}