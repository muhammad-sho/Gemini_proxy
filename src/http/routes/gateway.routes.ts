import type { FastifyPluginAsync } from "fastify";
import type { AppDeps } from "../server.js";
import { ClientDisconnectedError } from "../../application/gateway/routing.service.js";
import { deriveModelCatalog } from "../../application/gateway/catalog.js";
import {
  abortOnClientDisconnect,
  authenticateClient,
  enforceClientKeyRate,
  extractGeminiApiKey,
  isModelAllowed,
  resolveRoutePlan,
  sendUnauthorized
} from "./clientAccess.js";

function parseModelFromPath(path: string): { modelId: string; action: string } | null {
  const match = path.match(/\/models\/([^/:]+)(?::(\w+))?$/);
  if (!match) return null;
  return { modelId: decodeURIComponent(match[1]), action: match[2] ?? "" };
}

/**
 * Gemini-protocol gateway. Every request on this surface speaks the Gemini
 * wire format; bodies are forwarded to native Gemini upstreams verbatim and
 * translated by adapters for other provider types.
 */
export function gatewayRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    // Model discovery: derived from the models selected on active credentials.
    app.get("/v1beta/models", async (req, reply) => {
      const clientKey = authenticateClient(deps, extractGeminiApiKey(req));
      if (!clientKey) {
        const provided = extractGeminiApiKey(req) !== null;
        return sendUnauthorized(reply, req.id, provided ? "Invalid API key" : "Missing API key");
      }
      if (!enforceClientKeyRate(req, reply, clientKey.id, deps.settings.all().clientKeyRatePerMinute)) {
        return reply;
      }

      const filtered = deriveModelCatalog(deps.providerCredentialRepo.findAll())
        .filter(m => isModelAllowed(clientKey, m.id, deps));

      return reply.send({
        models: filtered.map(m => ({
          name: `models/${m.id}`,
          displayName: m.id,
          supportedGenerationMethods: ["generateContent"]
        }))
      });
    });

    // Generation passthrough with routing/retry/cooldown
    app.post("/v1beta/models/*", async (req, reply) => {
      const clientKey = authenticateClient(deps, extractGeminiApiKey(req));
      if (!clientKey) {
        const provided = extractGeminiApiKey(req) !== null;
        return sendUnauthorized(reply, req.id, provided ? "Invalid API key" : "Missing API key");
      }

      const url = new URL(req.url, "http://internal");
      const rawPath = url.pathname;
      const parsed = parseModelFromPath(rawPath);
      if (!parsed || parsed.action !== "generateContent") {
        return reply.status(404).send({
          error: { code: 404, message: "Only models/{model}:generateContent is proxied", requestId: req.id }
        });
      }

      if (!isModelAllowed(clientKey, parsed.modelId, deps)) {
        return reply.status(403).send({
          error: { code: 403, message: `Model not permitted: ${parsed.modelId}`, requestId: req.id }
        });
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
          abortSignal: abortOnClientDisconnect(reply),
          plan: resolveRoutePlan(clientKey, parsed.modelId, deps)
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
