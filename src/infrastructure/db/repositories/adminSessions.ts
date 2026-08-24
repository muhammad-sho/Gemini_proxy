import { getDb } from "../connection.js";
import { randomUUID } from "crypto";
import { generateCsrfToken, constantTimeEqual } from "../../../shared/crypto.js";

export interface AdminSession {
  id: string;
  user_id: number;
  csrf_token: string;
  expires_at: number;
  created_at: number;
}

export class AdminSessionRepository {
  private db = getDb();

  private stmtGetById = this.db.prepare("SELECT * FROM admin_sessions WHERE id = ?");
  private stmtInsert = this.db.prepare(`
    INSERT INTO admin_sessions (id, user_id, csrf_token, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  private stmtDelete = this.db.prepare("DELETE FROM admin_sessions WHERE id = ?");
  private stmtDeleteExpired = this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?");

  findById(sessionId: string): AdminSession | undefined {
    return this.stmtGetById.get(sessionId) as AdminSession | undefined;
  }

  create(userId: number, ttlMs: number = 24 * 60 * 60 * 1000): AdminSession {
    const id = randomUUID();
    const csrfToken = generateCsrfToken();
    const expiresAt = Date.now() + ttlMs;

    this.stmtInsert.run(id, userId, csrfToken, expiresAt);

    return {
      id,
      user_id: userId,
      csrf_token: csrfToken,
      expires_at: expiresAt,
      created_at: Date.now()
    };
  }

  delete(sessionId: string): boolean {
    const result = this.stmtDelete.run(sessionId);
    return result.changes > 0;
  }

  deleteExpired(): number {
    const result = this.stmtDeleteExpired.run(Date.now());
    return result.changes;
  }

  validateCsrf(session: AdminSession, providedToken: string): boolean {
    return constantTimeEqual(session.csrf_token, providedToken);
  }
}