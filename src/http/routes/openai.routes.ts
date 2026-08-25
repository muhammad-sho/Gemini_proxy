import type { FastifyPluginAsync } from "fastify";
import type { AppDeps } from "../server.js";
import { ClientDisconnectedError } from "../../application/gateway/routing.service.js";
import {
  chatRequestToGenerate,
  generateResponseToChat,
  upstreamErrorToChat,
  type OpenAiErrorBody
} from "../../application/gateway/openai.protocol.js";
import { chatCompletionCreateSchema } from "../../shared/validation.js";
import {
  abortOnClientDisconnect,
  authenticateClient,
  extractBearerToken,
  isModelAllowed
} from "./clientAccess.js";

function openAiError(status: number, message: string, type: string): OpenAiErrorBody {
  return { error: { message, type, code: status } };
}

/**
 * OpenAI-protocol gateway. Every request on this surface speaks the OpenAI
 * wire format (Authorization: Bearer auth, /v1/models, /v1/chat/completions).
 * Bodies are translated to the canonical internal shape and served by the
 * same credential pool as the Gemini gateway.
 */
export function openaiRoutes(deps: AppDeps): FastifyPluginAsync {
  return async (app) => {
    // Model discovery in OpenAI list format
    app.get("/v1/models", async (req, reply) => {
      const clientKey = authenticateClient(deps, extractBearerToken(req));
      if (!clientKey) {
        const provided = extractBearerToken(req) !== null;
        return reply.status(401).send(
          openAiError(401, provided ? "Invalid API key" : "Missing API key", "authentication_error")
        );
      }

      const cached = deps.cacheRepo.getAll();
      deps.modelCacheService.maybeRefresh();

      const data = cached
        .map(row => {
          try { return JSON.parse(row.raw_data); } catch { return null; }
        })
        .filter(Boolean)
        .filter((m: any) => isModelAllowed(clientKey, m.id, deps))
        .map((m: any) => ({
          id: m.id,
          object: "model",
          created: Math.floor((m.createdAt ?? Date.now()) / 1000),
          owned_by: "gemini-proxy"
        }));

      return reply.send({ object: "list", data });
    });

    // Chat completions with routing/retry/cooldown shared across gateways
    app.post("/v1/chat/completions", async (req, reply) => {
      const clientKey = authenticateClient(deps, extractBearerToken(req));
      if (!clientKey) {
        const provided = extractBearerToken(req) !== null;
        return reply.status(401).send(
          openAiError(401, provided ? "Invalid API key" : "Missing API key", "authentication_error")
        );
      }

      const parsed = chatCompletionCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        const message = parsed.error.errors.map(e => e.message).join("; ");
        return reply.status(400).send(openAiError(400, message, "invalid_request_error"));
      }
      if (parsed.data.stream === true) {
        return reply.status(400).send(
          openAiError(400, "Streaming is not supported yet; omit \"stream\" or set it to false", "invalid_request_error")
        );
      }

      const modelId = parsed.data.model;
      if (!isModelAllowed(clientKey, modelId, deps)) {
        return reply.status(403).send(
          openAiError(403, `Model not permitted: ${modelId}`, "permission_error")
        );
      }

      // Canonical internal request is Gemini-shaped; adapters translate per upstream.
      const generateRequest = chatRequestToGenerate(parsed.data);
      const canonicalPath = `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

      try {
        const result = await deps.routingService.route({
          method: "POST",
          path: canonicalPath,
          query: new URLSearchParams(),
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify(generateRequest)),
          clientKeyId: clientKey.id,
          modelId,
          action: "generateContent",
          abortSignal: abortOnClientDisconnect(reply)
        });

        let upstreamBody: unknown = null;
        try { upstreamBody = JSON.parse(result.body.toString("utf8")); } catch { /* non-JSON */ }

        if (result.status >= 200 && result.status < 300 && upstreamBody) {
          if (result.headers["retry-after"]) {
            reply.header("retry-after", result.headers["retry-after"]);
          }
          return reply.send(generateResponseToChat(upstreamBody as never, modelId));
        }

        reply.status(result.status === 503 ? 503 : result.status);
        return reply.send(upstreamErrorToChat(result.status, upstreamBody));
      } catch (err) {
        if (err instanceof ClientDisconnectedError) {
          return reply;
        }
        throw err;
      }
    });
  };
}
