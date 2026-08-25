import type { ProviderAdapter, UpstreamCredential, GenerateRequest } from "../../domain/providers/adapter.js";
import type { GeminiAdapter } from "../../infrastructure/providers/gemini.adapter.js";
import type { OpenAICompatibleAdapter } from "../../infrastructure/providers/openai-compatible.adapter.js";
import { cooldownFor, type CooldownPolicy } from "../../domain/routing/cooldown.js";
import { orderCandidates, type KeyCandidate } from "../../domain/routing/keySelection.js";
import type { ModelCredentialStateRepository } from "../../infrastructure/db/repositories/modelCredentialState.js";
import type { ProviderCredentialRepository } from "../../infrastructure/db/repositories/providerCredentials.js";
import type { UsageEventRepository } from "../../infrastructure/db/repositories/usageEvents.js";
import type { RequestLogRepository } from "../../infrastructure/db/repositories/requestLogs.js";
import { randomUUID } from "crypto";
import type { Logger } from "../../infrastructure/logging/logger.js";
import { RESPONSE_LIMIT_BYTES } from "../../shared/constants.js";
import { errMessage } from "../../shared/errors.js";
import type { ProxySettings, SettingsService } from "../../domain/settings/settingsService.js";
import type { SelectionStrategy } from "./../../domain/routing/keySelection.js";

export interface RoutePlan {
  /** Restrict candidates to these credential ids (group-scoped routing). */
  credentialIds?: string[];
  /** Ordering for the first pick; defaults to least_used. */
  primary?: SelectionStrategy;
  /** Re-ranking applied to the remaining pool after a failed attempt. */
  fallback?: SelectionStrategy;
}

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  credentialId: string | null;
  attempts: number;
  outcome: "success" | "error" | "timeout" | "aborted" | "no_keys";
  classification: string | null;
}

interface TimelineEvent {
  at: string;
  event: string;
  detail?: unknown;
}

export interface RouteRequestInput {
  method: string;
  path: string; // e.g. /v1beta/models/gemini-pro:generateContent
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer | null;
  clientKeyId: string | null;
  modelId: string;
  action: string; // e.g. generateContent
  abortSignal: AbortSignal;
  /** Group-derived routing constraints (strategies + candidate scope). */
  plan?: RoutePlan;
}

export class RoutingService {
  private adapters: Map<string, ProviderAdapter>;

  constructor(
    private credentialRepo: ProviderCredentialRepository,
    private stateRepo: ModelCredentialStateRepository,
    private usageRepo: UsageEventRepository,
    private logRepo: RequestLogRepository,
    private logger: Logger,
    geminiAdapter: GeminiAdapter,
    openaiAdapter: OpenAICompatibleAdapter,
    private settings: SettingsService
  ) {
    this.adapters = new Map<string, ProviderAdapter>([
      ["gemini", geminiAdapter],
      ["openai_compatible", openaiAdapter]
    ]);
  }

  async route(input: RouteRequestInput): Promise<UpstreamResult> {
    const settings: ProxySettings = this.settings.all();
    const traceId = randomUUID();
    const startedAt = Date.now();
    const timeline: TimelineEvent[] = [];
    const push = (event: string, detail?: unknown) => {
      timeline.push({ at: new Date().toISOString(), event, ...(detail !== undefined ? { detail } : {}) });
    };

    // A credential can only serve models the admin selected on it.
    const capable = this.credentialRepo.findAllWithKeys().filter(c =>
      this.adapterFor(c) !== null &&
      (c.allowed_models.length === 0 || c.allowed_models.includes(input.modelId)) &&
      (input.plan?.credentialIds === undefined || input.plan.credentialIds.includes(c.id))
    );

    if (capable.length === 0) {
      push("no_credentials", {});
      const reason = input.plan?.credentialIds
        ? "No credential in the assigned group serves this model"
        : "No provider credentials configured";
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          error: { code: 503, message: reason, requestId: traceId }
        })),
        credentialId: null,
        attempts: 0,
        outcome: "no_keys",
        classification: null
      };
    }

    const now = Date.now();
    const candidates: KeyCandidate[] = capable.map(cred => {
      const existing = this.stateRepo.get(input.modelId, cred.id);
      return {
        credentialId: cred.id,
        modelId: input.modelId,
        state: existing?.state ?? "ready",
        cooldownUntil: existing?.cooldown_until ?? null,
        useCount: existing?.use_count ?? 0,
        lastUsedAt: existing?.last_used_at ?? null,
        errorCount: existing?.error_count ?? 0,
        avgLatencyMs: existing?.avg_latency_ms ?? null,
        createdAt: this.candidateSeq(cred)
      };
    });

    // Promote expired cooling keys back to ready
    for (const candidate of candidates) {
      if (candidate.state === "cooling" && (candidate.cooldownUntil ?? 0) <= now) {
        this.stateRepo.updateState(candidate.modelId, candidate.credentialId, "ready", null, null);
        candidate.state = "ready";
        candidate.cooldownUntil = null;
        push("cooldown_expired", { credentialId: candidate.credentialId });
      }
    }

    const primary = input.plan?.primary ?? "least_used";
    const fallback = input.plan?.fallback;
    let pool: KeyCandidate[] = orderCandidates(candidates, now, primary).map(o => o.candidate);
    const maxAttempts = Math.min(settings.keyFallbackAttempts, pool.length);
    const deadline = startedAt + settings.keyLoopDeadlineMs;

    let lastResult: UpstreamResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() >= deadline || input.abortSignal.aborted) break;
      if (pool.length === 0) break;

      // Pick the best remaining candidate; after a failure the rest of the
      // pool is re-ranked by the group's fallback strategy (if configured).
      if (attempt > 1 && fallback) {
        pool = orderCandidates(pool, now, fallback).map(o => o.candidate);
      }
      const entry = pool.shift()!;
      const credential = capable.find(c => c.id === entry.credentialId)!;
      const adapter = this.adapterFor(credential)!;
      const upstream = this.toUpstream(credential);
      const attemptStartedAt = Date.now();

      push("attempt_start", { attempt, credentialId: credential.id, provider: credential.provider });
      this.stateRepo.incrementUse(input.modelId, credential.id);

      const remainingMs = deadline - Date.now();
      const timeoutMs = Math.min(remainingMs, settings.requestTimeoutMs);
      const controller = new AbortController();
      const onClientAbort = () => controller.abort();
      input.abortSignal.addEventListener("abort", onClientAbort, { once: true });
      const timeoutTimer = setTimeout(
        () => controller.abort(new DOMException("Upstream timeout", "TimeoutError")),
        Math.max(timeoutMs, 1)
      );

      try {
        const url = adapter.buildUrl(upstream, input.path);
        // Query params are Gemini-flavored (e.g. alt=sse); forward them only
        // to gemini-native upstreams.
        const qs = adapter.providerType === "gemini" ? input.query.toString() : "";
        const urlWithQuery = qs ? `${url}?${qs}` : url;
        const result = await this.callUpstream(
          adapter,
          upstream,
          urlWithQuery,
          input,
          controller.signal
        );

        if (result.status >= 200 && result.status < 300) {
          push("attempt_success", { attempt, status: result.status });
          this.stateRepo.recordSuccess(input.modelId, credential.id);
          this.stateRepo.recordLatency(input.modelId, credential.id, Date.now() - attemptStartedAt);
          const tokens = extractUsageTokens(result.headers["content-type"], result.body);
          this.recordUsage(input, credential.id, result.status, Date.now() - startedAt, null, tokens);
          this.persistLog(input, traceId, timeline, result, credential.id, attempt, maxAttempts, startedAt);
          return { ...result, attempts: attempt, outcome: "success", credentialId: credential.id, classification: null };
        }

        const bodyText = result.body.toString("utf8").slice(0, 4096);
        let parsedBody: unknown = null;
        try { parsedBody = JSON.parse(bodyText); } catch { /* non-JSON */ }

        const classification = adapter.classifyError(parsedBody, result.status);
        const errObj = (parsedBody ?? {}) as { error?: { message?: string; details?: unknown[] }; message?: string };
        const policy: CooldownPolicy = cooldownFor(classification, {
          message: errObj.error?.message ?? errObj.message,
          quotaDetails: errObj.error?.details
        });

        push("attempt_failed", { attempt, status: result.status, classification, policy });

        if (policy.kind !== "none") {
          this.stateRepo.updateState(
            input.modelId,
            credential.id,
            "cooling",
            Date.now() + policy.durationMs,
            policy.reason
          );
        }
        this.stateRepo.incrementError(input.modelId, credential.id, `HTTP ${result.status}`);
        this.recordUsage(input, credential.id, result.status, Date.now() - startedAt, String(classification));

        lastResult = { ...result, attempts: attempt, outcome: "error", classification };
        // continue to next candidate
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        if (input.abortSignal.aborted) {
          push("client_aborted", { attempt });
          this.persistLog(input, traceId, timeline, {
            status: null, headers: {}, body: Buffer.alloc(0), credentialId: credential.id
          }, credential.id, attempt, maxAttempts, startedAt, "aborted");
          throw new ClientDisconnectedError(traceId);
        }
        push("attempt_exception", { attempt, error: aborted ? "timeout" : errMessage(err).slice(0, 200) });
        this.stateRepo.incrementError(input.modelId, credential.id, aborted ? "timeout" : errMessage(err).slice(0, 200));
        lastResult = {
          status: 502,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: { code: 502, message: "Upstream request failed", requestId: traceId } })),
          credentialId: credential.id,
          attempts: attempt,
          outcome: aborted ? "timeout" : "error",
          classification: aborted ? "timeout" : "transient"
        };
      } finally {
        clearTimeout(timeoutTimer);
        input.abortSignal.removeEventListener("abort", onClientAbort);
      }
    }

    if (lastResult) {
      this.persistLog(input, traceId, timeline, lastResult, lastResult.credentialId, lastResult.attempts || maxAttempts, maxAttempts, startedAt, lastResult.outcome === "timeout" ? "timeout" : "error");
      return lastResult;
    }

    push("deadline_exhausted", {});
    return {
      status: 502,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error: { code: 502, message: "No upstream attempts possible within deadline", requestId: traceId } })),
      credentialId: null,
      attempts: 0,
      outcome: "error",
      classification: "exhausted"
    };
  }

  private async callUpstream(
    adapter: ProviderAdapter,
    credential: UpstreamCredential,
    url: string,
    input: RouteRequestInput,
    signal: AbortSignal
  ): Promise<Omit<UpstreamResult, "attempts" | "outcome" | "classification">> {
    const headers = adapter.buildHeaders(credential);
    const allowlist = ["content-type", "accept", "user-agent"];
    const forwardedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      if (allowlist.includes(k.toLowerCase())) forwardedHeaders[k] = v;
    }

    // Gemini-native upstreams receive the body verbatim; other providers get
    // the Gemini-shaped payload translated by their adapter first.
    let body = input.body;
    if (body && body.length > 0 && adapter.providerType !== "gemini") {
      try {
        const geminiRequest = JSON.parse(body.toString("utf8")) as GenerateRequest & { model?: string };
        if (!geminiRequest.model) geminiRequest.model = input.modelId;
        const transformed = adapter.transformRequest(geminiRequest);
        body = Buffer.from(JSON.stringify(transformed));
        delete forwardedHeaders["accept"];
      } catch (err) {
        this.logger.warn({ err }, "request translation failed; forwarding original body");
      }
    }

    const response = await fetch(url, {
      method: input.method,
      headers: { ...headers, ...forwardedHeaders },
      body: body && body.length > 0 ? body : undefined,
      signal
    });

    const responseHeaders: Record<string, string> = {};
    const headerAllowlist = ["content-type", "retry-after", "x-request-id", "server", "date"];
    for (const [k, v] of response.headers) {
      if (headerAllowlist.includes(k.toLowerCase())) responseHeaders[k] = v;
    }

    const arrayBuffer = await response.arrayBuffer();
    let responseBody = Buffer.from(arrayBuffer);
    if (responseBody.length > RESPONSE_LIMIT_BYTES) {
      responseBody = responseBody.subarray(0, RESPONSE_LIMIT_BYTES);
    }

    // Translate successful non-Gemini responses back into Gemini shape so
    // clients always speak one protocol regardless of upstream provider.
    const contentType = responseHeaders["content-type"] ?? "";
    if (
      response.ok &&
      adapter.providerType !== "gemini" &&
      contentType.includes("application/json") &&
      responseBody.length > 0
    ) {
      try {
        const parsed = JSON.parse(responseBody.toString("utf8"));
        const translated = adapter.transformResponse(parsed);
        responseBody = Buffer.from(JSON.stringify(translated));
        responseHeaders["content-type"] = "application/json";
      } catch (err) {
        this.logger.warn({ err }, "response translation failed; returning original body");
      }
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
      credentialId: credential.id
    };
  }

  private recordUsage(
    input: RouteRequestInput,
    credentialId: string,
    statusCode: number | null,
    latencyMs: number,
    errorClassification: string | null,
    tokens?: { prompt: number; completion: number }
  ): void {
    if (!input.clientKeyId) return;
    try {
      this.usageRepo.record({
        client_key_id: input.clientKeyId,
        provider_id: credentialId,
        model_id: input.modelId,
        request_tokens: tokens?.prompt ?? null,
        response_tokens: tokens?.completion ?? null,
        latency_ms: latencyMs,
        status_code: statusCode,
        error_message: errorClassification
      });
      // Same retention cap as request logs keeps both tables bounded.
      this.usageRepo.prune(this.settings.all().maxLogEntries);
    } catch (err) {
      this.logger.warn({ err }, "usage recording failed");
    }
  }

  private persistLog(
    input: RouteRequestInput,
    traceId: string,
    timeline: TimelineEvent[],
    result: { status: number | null; headers: Record<string, string>; body: Buffer; credentialId: string | null },
    credentialId: string | null,
    attemptNumber: number,
    totalAttempts: number,
    startedAt: number,
    finalOutcome: UpstreamResult["outcome"] = "success"
  ): void {
    const settings = this.settings.all();
    try {
      const reqBody = input.body ? truncate(input.body.toString("utf8"), settings.logBodyMaxBytes) : null;
      const resBody = result.body.length > 0 ? truncate(result.body.toString("utf8"), settings.logBodyMaxBytes) : null;

      this.logRepo.insert({
        trace_id: traceId,
        client_key_id: input.clientKeyId,
        provider_id: credentialId,
        model_id: input.modelId,
        method: input.method,
        path: input.path,
        request_headers: JSON.stringify(sanitizeHeaders(input.headers)),
        request_body: reqBody,
        response_status: result.status ?? null,
        response_headers: JSON.stringify(result.headers),
        response_body: resBody,
        latency_ms: Date.now() - startedAt,
        attempt_number: attemptNumber,
        total_attempts: totalAttempts,
        final_outcome: finalOutcome,
        error_classification: result.status && result.status >= 400 ? String(result.status) : null,
        timeline: JSON.stringify(timeline)
      });
      this.logRepo.prune(settings.maxLogEntries);
    } catch (err) {
      this.logger.warn({ err }, "request log persistence failed");
    }
  }

  adapterFor(credential: { provider: string }): ProviderAdapter | null {
    return this.adapters.get(credential.provider) ?? null;
  }

  private toUpstream(credential: {
    id: string;
    provider: "gemini" | "openai_compatible";
    apiKey: string;
    base_url: string | null;
  }): UpstreamCredential {
    return {
      id: credential.id,
      provider: credential.provider,
      apiKey: credential.apiKey,
      baseUrl: credential.base_url
    };
  }

  private candidateSeq(credential: { seq?: number; created_at?: number }): number {
    return credential.seq ?? credential.created_at ?? 0;
  }
}

export class ClientDisconnectedError extends Error {
  constructor(public traceId: string) {
    super("Client disconnected");
    this.name = "ClientDisconnectedError";
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.includes("authorization") || lower.includes("api-key") || lower.includes("cookie")) {
      sanitized[k] = "[REDACTED]";
    } else {
      sanitized[k] = v.slice(0, 500);
    }
  }
  return sanitized;
}

function truncate(text: string, maxChars: number): string {
  return text.slice(0, maxChars);
}

interface UsageMetadataShape {
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Pull prompt/completion token counts out of a successful Gemini-shaped body
 * (native Gemini responses and adapter-translated responses both carry it).
 */
export function extractUsageTokens(contentType: string | undefined, body: Buffer): { prompt: number; completion: number } {
  if (!contentType || !contentType.includes("application/json") || body.length === 0) {
    return { prompt: 0, completion: 0 };
  }
  try {
    const parsed = JSON.parse(body.toString("utf8")) as UsageMetadataShape;
    return {
      prompt: parsed.usageMetadata?.promptTokenCount ?? 0,
      completion: parsed.usageMetadata?.candidatesTokenCount ?? 0
    };
  } catch {
    return { prompt: 0, completion: 0 };
  }
}
