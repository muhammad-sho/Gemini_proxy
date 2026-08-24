import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AppDeps } from "../server.js";

const SESSION_COOKIE = "gemini_admin_session";
const CSRF_COOKIE = "gemini_csrf";

export function authRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    app.post("/login", async (req, reply) => {
      const body = (req.body ?? {}) as { token?: string };
      if (!body.token || typeof body.token !== "string") {
        return reply.status(400).send({ error: { code: 400, message: "token required", requestId: req.id } });
      }

      const ip = req.ip;
      const result = deps.adminSessionService.login(body.token, ip);
      if (!result) {
        return reply.status(401).send({ error: { code: 401, message: "Invalid token", requestId: req.id } });
      }

      // Secure flag must follow the actual connection protocol, not NODE_ENV:
      // over plain-HTTP LAN deployments a Secure cookie is dropped by the browser.
      const secure = req.protocol === "https";

      reply.setCookie(SESSION_COOKIE, result.sessionId, {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/"
      });
      reply.setCookie(CSRF_COOKIE, result.csrfToken, {
        httpOnly: false,
        sameSite: "strict",
        secure,
        path: "/"
      });

      // Audit
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

function recordAudit(
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
