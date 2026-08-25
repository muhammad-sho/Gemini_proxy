import { getDb } from "../../infrastructure/db/connection.js";
import { verifyPassword, hashPassword } from "../../shared/crypto.js";

export interface AdminUser {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}

export class AuthService {
  private db = getDb();
  private stmtGetByUsername = this.db.prepare("SELECT * FROM admin_users WHERE username = ?");
  private stmtCount = this.db.prepare("SELECT COUNT(*) as count FROM admin_users");
  private stmtInsert = this.db.prepare(
    "INSERT INTO admin_users (username, password_hash) VALUES (?, ?)"
  );

  findByUsername(username: string): AdminUser | undefined {
    return this.stmtGetByUsername.get(username) as AdminUser | undefined;
  }

  hasAnyUser(): boolean {
    const row = this.stmtCount.get() as { count: number };
    return row.count > 0;
  }

  createUser(username: string, password: string): AdminUser {
    const hash = hashPassword(password);
    const result = this.stmtInsert.run(username, hash);
    return {
      id: Number(result.lastInsertRowid),
      username,
      password_hash: hash,
      created_at: Math.floor(Date.now() / 1000)
    };
  }

  verifyPassword(user: AdminUser, password: string): boolean {
    return verifyPassword(password, user.password_hash);
  }
}