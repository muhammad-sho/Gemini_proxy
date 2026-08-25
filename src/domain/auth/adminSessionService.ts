import { AdminSessionRepository } from "../../infrastructure/db/repositories/adminSessions.js";
import { AuthService } from "./authService.js";

export interface SessionData {
  session: Awaited<ReturnType<AdminSessionRepository["findById"]>>;
  user: Awaited<ReturnType<AuthService["findByUsername"]>>;
}

export class AdminSessionService {
  private sessionRepo = new AdminSessionRepository();
  private authService = new AuthService();

  login(token: string, _ipAddress: string): { sessionId: string; csrfToken: string } | null {
    const user = this.authService.findByUsername("admin");
    if (!user || !this.authService.verifyPassword(user, token)) {
      return null;
    }
    return this.createSessionFor(user.id);
  }

  /** True once an admin account exists (first-run setup completed). */
  isProvisioned(): boolean {
    return this.authService.hasAnyUser();
  }

  /**
   * First-run provisioning: create the admin account when none exists.
   * Returns the created user, or null when the app is already set up.
   */
  provision(password: string): { id: number } | null {
    if (this.authService.hasAnyUser()) return null;
    const user = this.authService.createUser("admin", password);
    return { id: user.id };
  }

  createSessionFor(userId: number): { sessionId: string; csrfToken: string } {
    // Housekeeping: drop long-expired sessions so the table doesn't grow forever.
    this.sessionRepo.deleteExpired();
    const session = this.sessionRepo.create(userId);
    return {
      sessionId: session.id,
      csrfToken: session.csrf_token
    };
  }

  validateSession(sessionId: string, csrfToken?: string): SessionData | null {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) return null;

    if (session.expires_at < Date.now()) {
      this.sessionRepo.delete(sessionId);
      return null;
    }

    if (csrfToken && !this.sessionRepo.validateCsrf(session, csrfToken)) {
      return null;
    }

    const user = this.authService.findByUsername("admin");
    if (!user) return null;

    return { session, user };
  }

  logout(sessionId: string): void {
    this.sessionRepo.delete(sessionId);
  }

  renew(sessionId: string, ttlMs?: number): void {
    this.sessionRepo.renew(sessionId, ttlMs);
  }

  getCsrfToken(sessionId: string): string | null {
    const session = this.sessionRepo.findById(sessionId);
    return session?.csrf_token ?? null;
  }
}