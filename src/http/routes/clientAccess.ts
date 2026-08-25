import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../server.js";
import type { ClientKey } from "../../infrastructure/db/repositories/clientKeys.js";
import { hashApiKey } from "../../shared/crypto.js";

/**
 * Shared helpers for the two gateway surfaces. Each surface authenticates the
 * same pool of proxy client keys but speaks its own wire format.
 */

/** Gemini-style extraction: x-goog-api-key header, Bearer token, or ?key= param. */
export function extractGeminiApiKey(req: FastifyRequest): string | null {
  const header = req.headers["x-goog-api-key"];
  if (typeof header === "string" && header.length > 0) return header;
  return extractBearerToken(req) ?? queryParamsKey(req);
}

/** OpenAI-style extraction: Authorization: Bearer <token> only. */
export function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim() || null;
  }
  return null;
}

function queryParamsKey(req: FastifyRequest): string | null {
  const query = req.query as Record<string, string> | undefined;
  return query?.key ?? null;
}

export function authenticateClient(deps: AppDeps, apiKey: string | null): ClientKey | null {
  if (!apiKey) return null;
  return deps.clientKeyRepo.findByHash(hashApiKey(apiKey)) ?? null;
}

export function sendUnauthorized(reply: FastifyReply, requestId: string, message: string): FastifyReply {
  return reply.status(401).send({
    error: { code: 401, message, requestId }
  });
}

/**
 * Permission check shared by both gateways: an empty allowlist pair means
 * unrestricted access; otherwise the model must be listed directly on the
 * client key or reachable through one of its groups (any pair with that model).
 */
export function isModelAllowed(
  clientKey: ClientKey,
  modelId: string,
  deps: Pick<AppDeps, "groupRepo">
): boolean {
  const hasRestrictions = clientKey.allowed_models.length > 0 || clientKey.allowed_groups.length > 0;
  if (!hasRestrictions) return true;
  if (clientKey.allowed_models.includes(modelId)) return true;
  return deps.groupRepo.expandModelIds(clientKey.allowed_groups).includes(modelId);
}

/**
 * Routing plan for a request: the first group (in client-key order) that
 * contains a pair for this model scopes candidates to that group's
 * credentials and applies its routing strategies. Plain model assignments
 * fall back to basic least-used across every capable credential.
 */
export function resolveRoutePlan(
  clientKey: ClientKey,
  modelId: string,
  deps: AppDeps
): { credentialIds?: string[]; primary?: import("../../domain/routing/keySelection.js").SelectionStrategy; fallback?: import("../../domain/routing/keySelection.js").SelectionStrategy } | undefined {
  const resolved = deps.groupRepo.resolveForModel(clientKey.allowed_groups, modelId);
  if (!resolved) return undefined;
  return {
    credentialIds: resolved.credentialIds,
    primary: resolved.routingStrategy,
    fallback: resolved.fallbackStrategy ?? undefined
  };
}

/**
 * Abort signal that fires only when the TCP client actually goes away
 * mid-flight. Uses the response stream: 'close' with writableFinished=false
 * means the socket died before we could write anything ('close' always fires
 * after a normal response too, hence the writableFinished check).
 */
export function abortOnClientDisconnect(reply: FastifyReply): AbortSignal {
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
