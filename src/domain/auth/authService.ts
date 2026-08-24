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
  private stmtUpdatePassword = this.db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?");

  findByUsername(username: string): AdminUser | undefined {
    return this.stmtGetByUsername.get(username) as AdminUser | undefined;
  }

  verifyPassword(user: AdminUser, password: string): boolean {
    return verifyPassword(password, user.password_hash);
  }

  changePassword(userId: number, newPassword: string): void {
    const hash = hashPassword(newPassword);
    this.stmtUpdatePassword.run(hash, userId);
  }
}