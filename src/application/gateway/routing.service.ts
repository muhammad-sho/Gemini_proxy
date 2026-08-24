import type { ProviderAdapter, UpstreamCredential } from "../../domain/providers/adapter.js";
import type { GeminiAdapter } from "../../infrastructure/providers/gemini.adapter.js";
import type { OpenAICompatibleAdapter } from "../../infrastructure/providers/openai-compatible.adapter.js";
import { cooldownFor, type CooldownPolicy } from "../../domain/routing/cooldown.js";
import { orderCandidates, type KeyCandidate } from "../../domain/routing/keySelection.js";
import type { ModelCredentialStateRepository } from "../../infrastructure/db/repositories/modelCredentialState.js";
import type { ProviderCredentialRepository } from "../../infrastructure/db/repositories/providerCredentials.js";
import type { UsageEventRepository } from "../../infrastructure/db/repositories/usageEvents.js";
import type { RequestLogRepository } from "../../infrastructure/db/repositories/requestLogs.js";
import type { ModelCacheRepository } from "../../infrastructure/db/repositories/modelCache.js";
import { randomUUID } from "crypto";
import type { Logger } from "../../infrastructure/logging/logger.js";
import { getConfig } from "../../config/env.js";

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
}

export class RoutingService {
  private adapters: Map<string, ProviderAdapter>;

  constructor(
    private credentialRepo: ProviderCredentialRepository,
    private stateRepo: ModelCredentialStateRepository,
    private usageRepo: UsageEventRepository,
    private logRepo: RequestLogRepository,
    private cacheRepo: ModelCacheRepository,
    private logger: Logger,
    geminiAdapter: GeminiAdapter,
    openaiAdapter: OpenAICompatibleAdapter
  ) {
    this.adapters = new Map<string, ProviderAdapter>([
      ["gemini", geminiAdapter],
      ["openai_compatible", openaiAdapter]
    ]);
  }

  async route(input: RouteRequestInput): Promise<UpstreamResult> {
    const config = getConfig();
    const traceId = randomUUID();
    const startedAt = Date.now();
    const timeline: TimelineEvent[] = [];
    const push = (event: string, detail?: unknown) => {
      timeline.push({ at: new Date().toISOString(), event, ...(detail !== undefined ? { detail } : {}) });
    };

    const credentials = this.credentialRepo.findAllWithKeys().filter(c =>
      this.adapterFor(c) !== null
    );

    if (credentials.length === 0) {
      push("no_credentials", {});
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ error: "No provider credentials configured" })),
        credentialId: null,
        attempts: 0,
        outcome: "no_keys",
        classification: null
      };
    }

    const now = Date.now();
    const candidates: KeyCandidate[] = credentials.map(cred => {
      const existing = this.stateRepo.get(input.modelId, cred.id);
      return {
        credentialId: cred.id,
        modelId: input.modelId,
        state: existing?.state ?? "ready",
        cooldownUntil: existing?.cooldown_until ?? null,
        useCount: existing?.use_count ?? 0,
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

    const ordered = orderCandidates(candidates, now);
    const maxAttempts = Math.min(config.keyFallbackAttempts, ordered.length);
    const deadline = startedAt + config.keyLoopDeadlineMs;

    let lastResult: UpstreamResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (Date.now() >= deadline || input.abortSignal.aborted) break;

      const entry = ordered[attempt - 1];
      const credential = credentials.find(c => c.id === entry.candidate.credentialId)!;
      const adapter = this.adapterFor(credential)!;
      const upstream = this.toUpstream(credential);

      push("attempt_start", { attempt, credentialId: credential.id, provider: credential.provider });
      this.stateRepo.incrementUse(input.modelId, credential.id);

      const remainingMs = deadline - Date.now();
      const timeoutMs = Math.min(remainingMs, config.requestTimeoutMs);
      const controller = new AbortController();
      const onClientAbort = () => controller.abort();
      input.abortSignal.addEventListener("abort", onClientAbort, { once: true });
      const timeoutTimer = setTimeout(
        () => controller.abort(new DOMException("Upstream timeout", "TimeoutError")),
        Math.max(timeoutMs, 1)
      );

      try {
        const url = adapter.buildUrl(upstream, input.path);
        const result = await this.callUpstream(
          adapter,
          upstream,
          url,
          input,
          controller.signal,
          timeoutMs
        );

        if (result.status >= 200 && result.status < 300) {
          push("attempt_success", { attempt, status: result.status });
          this.recordUsage(input, credential.id, result.status, Date.now() - startedAt, null);
          this.persistLog(input, traceId, timeline, result, credential.id, attempt, maxAttempts, startedAt);
          return { ...result, attempts: attempt, outcome: "success", credentialId: credential.id, classification: null };
        }

        const bodyText = result.body.toString("utf8").slice(0, 4096);
        let parsedBody: unknown = null;
        try { parsedBody = JSON.parse(bodyText); } catch { /* non-JSON */ }

        const classification = adapter.classifyError(parsedBody, result.status);
        const policy: CooldownPolicy = cooldownFor(classification, {
          message: (parsedBody as any)?.error?.message ?? (parsedBody as any)?.message,
          quotaDetails: (parsedBody as any)?.error?.details
        });

        push("attempt_failed", { attempt, status: result.status, classification, policy });

        if (policy.kind !== "none") {
          this.stateRepo.updateState(
            input.modelId,
            credential.id,
            policy.kind === "daily_quota" ? "cooling" : policy.kind === "invalid_key" ? "cooling" : "cooling",
            Date.now() + policy.durationMs,
            policy.reason
          );
        }
        this.stateRepo.incrementError(input.modelId, credential.id, `HTTP ${result.status}`);
        this.recordUsage(input, credential.id, result.status, Date.now() - startedAt, String(classification));

        lastResult = { ...result, attempts: attempt, outcome: "error", classification };
        // continue to next candidate
      } catch (err: any) {
        const aborted = err?.name === "AbortError";
        if (input.abortSignal.aborted) {
          push("client_aborted", { attempt });
          this.persistLog(input, traceId, timeline, {
            status: null, headers: {}, body: Buffer.alloc(0), credentialId: credential.id
          }, credential.id, attempt, maxAttempts, startedAt, "aborted");
          throw new ClientDisconnectedError(traceId);
        }
        push("attempt_exception", { attempt, error: aborted ? "timeout" : String(err?.message ?? err).slice(0, 200) });
        this.stateRepo.incrementError(input.modelId, credential.id, aborted ? "timeout" : String(err?.message ?? "").slice(0, 200));
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
    signal: AbortSignal,
    _timeoutMs: number
  ): Promise<Omit<UpstreamResult, "attempts" | "outcome" | "classification">> {
    const headers = adapter.buildHeaders(credential);
    const allowlist = ["content-type", "accept", "user-agent"];
    const forwardedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      if (allowlist.includes(k.toLowerCase())) forwardedHeaders[k] = v;
    }

    const response = await fetch(url, {
      method: input.method,
      headers: { ...headers, ...forwardedHeaders },
      body: input.body && input.body.length > 0 ? input.body : undefined,
      signal
    });

    const responseHeaders: Record<string, string> = {};
    const headerAllowlist = ["content-type", "retry-after", "x-request-id", "server", "date"];
    for (const [k, v] of response.headers) {
      if (headerAllowlist.includes(k.toLowerCase())) responseHeaders[k] = v;
    }

    const config = getConfig();
    const arrayBuffer = await response.arrayBuffer();
    let body = Buffer.from(arrayBuffer);
    if (body.length > config.maxResponseBytes) {
      body = body.subarray(0, config.maxResponseBytes);
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body,
      credentialId: credential.id
    };
  }

  private recordUsage(
    input: RouteRequestInput,
    credentialId: string,
    statusCode: number | null,
    latencyMs: number,
    errorClassification: string | null
  ): void {
    if (!input.clientKeyId) return;
    try {
      this.usageRepo.record({
        client_key_id: input.clientKeyId,
        provider_id: credentialId,
        model_id: input.modelId,
        request_tokens: null,
        response_tokens: null,
        latency_ms: latencyMs,
        status_code: statusCode,
        error_message: errorClassification
      });
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
    const config = getConfig();
    try {
      const maskKeys = [getConfig().setupToken];
      const reqBody = input.body ? truncateAndMask(input.body.toString("utf8"), config.logBodyMaxBytes, maskKeys) : null;
      const resBody = result.body.length > 0 ? truncateAndMask(result.body.toString("utf8"), config.logBodyMaxBytes, maskKeys) : null;

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
      this.logRepo.prune(config.maxLogEntries);
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

function truncateAndMask(text: string, maxBytes: number, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 8) {
      out = out.split(secret).join("[MASKED]");
    }
  }
  return out.slice(0, maxBytes);
}
