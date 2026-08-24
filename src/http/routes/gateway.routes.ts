import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { AppDeps } from "../server.js";
import { ClientDisconnectedError } from "../../application/gateway/routing.service.js";
import { hashApiKey } from "../../shared/crypto.js";

/**
 * Abort signal that fires only when the TCP client actually goes away mid-flight.
 * Uses the response stream: 'close' with writableFinished=false means the socket
 * died before we could write anything. ('close' always fires after a normal
 * response too, hence the writableFinished check.)
 */
function abortOnClientDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  const res = reply.raw;
  if (res.writableEnded || res.destroyed) {
    return AbortSignal.abort();
  }
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}


function extractApiKey(req: FastifyRequest): string | null {
  const header = req.headers["x-goog-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim() || null;
  }
  const query = req.query as Record<string, string>;
  if (query?.key) return query.key;
  return null;
}

function parseModelFromPath(path: string): { modelId: string; action: string } | null {
  const match = path.match(/\/models\/([^/:]+)(?::(\w+))?$/);
  if (!match) return null;
  return { modelId: decodeURIComponent(match[1]), action: match[2] ?? "" };
}

export function gatewayRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    // Model discovery passthrough
    app.get("/v1beta/models", async (req, reply) => {
      const apiKey = extractApiKey(req);
      if (!apiKey) {
        return reply.status(401).send({ error: { code: 401, message: "Missing API key", requestId: req.id } });
      }
      const clientKey = deps.clientKeyRepo.findByHash(hashApiKey(apiKey));
      if (!clientKey) {
        return reply.status(401).send({ error: { code: 401, message: "Invalid API key", requestId: req.id } });
      }

      const cached = deps.cacheRepo.getAll();
      const allowed = cached
        .map(row => {
          try { return JSON.parse(row.raw_data); } catch { return null; }
        })
        .filter(Boolean);

      // Apply client-key model allowlist
      const filtered = (clientKey.allowed_models.length === 0 && clientKey.allowed_groups.length === 0)
        ? allowed
        : allowed.filter((m: any) => {
            if (clientKey.allowed_models.includes(m.id)) return true;
            const groups = deps.groupRepo.expandModels(clientKey.allowed_groups);
            return groups.includes(m.id);
          });

      return reply.send({ models: filtered.map((m: any) => ({ name: `models/${m.id}`, ...m })) });
    });

    // Generation passthrough with routing/retry/cooldown
    app.post("/v1beta/models/*", async (req, reply) => {
      const apiKey = extractApiKey(req);
      if (!apiKey) {
        return reply.status(401).send({ error: { code: 401, message: "Missing API key", requestId: req.id } });
      }
      const clientKey = deps.clientKeyRepo.findByHash(hashApiKey(apiKey));
      if (!clientKey) {
        return reply.status(401).send({ error: { code: 401, message: "Invalid API key", requestId: req.id } });
      }

      const url = new URL(req.url, "http://internal");
      const rawPath = url.pathname;
      const parsed = parseModelFromPath(rawPath);
      if (!parsed || !parsed.action) {
        return reply.status(404).send({ error: { code: 404, message: "Unknown model route", requestId: req.id } });
      }

      // Model allowlist check
      const groups = deps.groupRepo.expandModels(clientKey.allowed_groups);
      const hasRestrictions = clientKey.allowed_models.length > 0 || clientKey.allowed_groups.length > 0;
      if (hasRestrictions &&
          !clientKey.allowed_models.includes(parsed.modelId) &&
          !groups.includes(parsed.modelId)) {
        return reply.status(403).send({ error: { code: 403, message: `Model not permitted: ${parsed.modelId}`, requestId: req.id } });
      }

      const bodyBuffer = req.body ? Buffer.from(JSON.stringify(req.body)) : null;

      try {
        const result = await deps.routingService.route({
          method: req.method,
          path: rawPath,
          query: url.searchParams,
          headers: Object.fromEntries(
            Object.entries(req.headers)
              .filter(([k]) => typeof req.headers[k] === "string")
              .map(([k, v]) => [k, String(v)])
          ),
          body: bodyBuffer,
          clientKeyId: clientKey.id,
          modelId: parsed.modelId,
          action: parsed.action,
          abortSignal: abortOnClientDisconnect(reply)
        });

        const headers: Record<string, string> = { "content-type": result.headers["content-type"] ?? "application/json" };
        if (result.headers["retry-after"]) headers["retry-after"] = result.headers["retry-after"];
        reply.status(result.status).headers(headers);
        return reply.send(new Uint8Array(result.body));
      } catch (err) {
        if (err instanceof ClientDisconnectedError) {
          // Client is gone; nothing to send.
          return reply;
        }
        throw err;
      }
    });

  };
}
