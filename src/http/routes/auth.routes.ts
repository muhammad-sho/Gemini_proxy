import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../server.js";

const SESSION_COOKIE = "gemini_admin_session";
const CSRF_COOKIE = "gemini_csrf";
// __Host- prefix (secure connections only): binds the cookie to this exact
// host, requires Secure + Path=/ and forbids Domain — strongest browser
// guarantees available.
const HOST_SESSION_COOKIE = "__Host-gemini_admin_session";
const HOST_CSRF_COOKIE = "__Host-gemini_csrf";

function cookieNames(secure: boolean): { session: string; csrf: string } {
  return secure
    ? { session: HOST_SESSION_COOKIE, csrf: HOST_CSRF_COOKIE }
    : { session: SESSION_COOKIE, csrf: CSRF_COOKIE };
}

function readSessionCookie(req: FastifyRequest): string | undefined {
  const cookies = req.cookies ?? {};
  return cookies[HOST_SESSION_COOKIE] ?? cookies[SESSION_COOKIE];
}

/** Dedicated brute-force bucket for credential endpoints (per IP). */
export const AUTH_RATE_LIMIT = {
  max: 10,
  timeWindow: "1 minute",
  keyGenerator: (req: FastifyRequest) => `auth:${req.ip}`
} as const;

export function authRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    // Public: lets the dashboard decide between first-run setup and login.
    app.get("/setup/status", async () => ({ setupRequired: !deps.adminSessionService.isProvisioned() }));

    // Public one-time provisioning: create the admin account on first open.
    app.post("/setup", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
      const body = (req.body ?? {}) as { password?: string };
      if (!body.password || typeof body.password !== "string" || body.password.length < 8) {
        return reply.status(400).send({
          error: { code: 400, message: "password must be at least 8 characters", requestId: req.id }
        });
      }

      const user = deps.adminSessionService.provision(body.password);
      if (!user) {
        return reply.status(409).send({
          error: { code: 409, message: "Admin account already exists", requestId: req.id }
        });
      }

      const result = deps.adminSessionService.createSessionFor(user.id);
      setSessionCookies(reply, result.sessionId, result.csrfToken, req.protocol);
      recordAudit(deps, user.id, "setup", "admin_user", String(user.id), req.ip);
      return { ok: true };
    });

    app.post("/login", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (req, reply) => {
      const body = (req.body ?? {}) as { token?: string };
      if (!body.token || typeof body.token !== "string") {
        return reply.status(400).send({ error: { code: 400, message: "token required", requestId: req.id } });
      }

      const ip = req.ip;
      const result = deps.adminSessionService.login(body.token, ip);
      if (!result) {
        return reply.status(401).send({ error: { code: 401, message: "Invalid password", requestId: req.id } });
      }

      setSessionCookies(reply, result.sessionId, result.csrfToken, req.protocol);
      recordAudit(deps, null, "login", "session", result.sessionId, ip);
      return { ok: true };
    });

    app.post("/logout", async (req, reply) => {
      const sessionId = readSessionCookie(req);
      if (sessionId) {
        deps.adminSessionService.logout(sessionId);
        recordAudit(deps, null, "logout", "session", sessionId, req.ip);
      }
      // Clear both variants so legacy cookies never linger.
      for (const name of [SESSION_COOKIE, HOST_SESSION_COOKIE]) {
        void reply.clearCookie(name, { path: "/" });
      }
      for (const name of [CSRF_COOKIE, HOST_CSRF_COOKIE]) {
        void reply.clearCookie(name, { path: "/" });
      }
      return { ok: true };
    });
  };
}

/** Secure flag follows the actual connection protocol, not NODE_ENV: over
 *  plain-HTTP LAN deployments a Secure cookie is dropped by the browser.
 *  HTTPS additionally upgrades to __Host- prefixed names. */
function setSessionCookies(reply: FastifyReply, sessionId: string, csrfToken: string, protocol: string): void {
  const secure = protocol === "https";
  const names = cookieNames(secure);
  const base = { httpOnly: true as const, sameSite: "strict" as const, secure, path: "/" };
  reply.setCookie(names.session, sessionId, base);
  reply.setCookie(names.csrf, csrfToken, { ...base, httpOnly: false });
}

export function recordAudit(
  deps: AppDeps,
  userId: number | null,
  action: string,
  entityType: string,
  entityId: string,
  ip: string
): void {
  try {
    deps.auditRepo.record({
      admin_user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details: null,
      ip_address: ip
    });
  } catch {
    // audit failures must not break auth flow
  }
}

export function requireAdmin(deps: AppDeps): (req: FastifyRequest) => { sessionId: string; csrfToken: string | undefined } | null {
  return (req) => {
    const sessionId = readSessionCookie(req);
    if (!sessionId) return null;
    const csrfHeader = req.headers["x-csrf-token"] as string | undefined;
    // Mutating requests must prove same-origin by echoing the CSRF cookie.
    const csrfRequired = req.method !== "GET" && req.method !== "HEAD";
    const data = deps.adminSessionService.validateSession(
      sessionId,
      csrfRequired ? csrfHeader : undefined
    );
    if (!data || !data.session) return null;
    if (csrfRequired && !csrfHeader) return null;

    // Sliding renewal: once past half the TTL, active use extends the session.
    const ttlMs = 24 * 60 * 60 * 1000;
    if (data.session.expires_at - Date.now() < ttlMs / 2) {
      deps.adminSessionService.renew(sessionId, ttlMs);
    }
    return { sessionId, csrfToken: csrfHeader ?? data.session.csrf_token };
  };
}
