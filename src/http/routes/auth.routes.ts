import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../server.js";

const SESSION_COOKIE = "gemini_admin_session";
const CSRF_COOKIE = "gemini_csrf";

export function authRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    // Public: lets the dashboard decide between first-run setup and login.
    app.get("/setup/status", async () => ({ setupRequired: !deps.adminSessionService.isProvisioned() }));

    // Public one-time provisioning: create the admin account on first open.
    app.post("/setup", async (req, reply) => {
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

    app.post("/login", async (req, reply) => {
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
      const sessionId = req.cookies?.[SESSION_COOKIE];
      if (sessionId) {
        deps.adminSessionService.logout(sessionId);
        recordAudit(deps, null, "logout", "session", sessionId, req.ip);
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return { ok: true };
    });
  };
}

/** Secure flag follows the actual connection protocol, not NODE_ENV: over
 *  plain-HTTP LAN deployments a Secure cookie is dropped by the browser. */
function setSessionCookies(reply: FastifyReply, sessionId: string, csrfToken: string, protocol: string): void {
  const secure = protocol === "https";
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/"
  });
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    sameSite: "strict",
    secure,
    path: "/"
  });
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
    const sessionId = req.cookies?.[SESSION_COOKIE];
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
    return { sessionId, csrfToken: csrfHeader ?? data.session.csrf_token };
  };
}
