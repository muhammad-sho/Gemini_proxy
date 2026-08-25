import {
  type ProviderAdapter,
  type UpstreamCredential,
  type ProviderModel,
  type GenerateRequest,
  type GenerateResponse,
  classifyUpstreamError
} from "../../domain/providers/adapter.js";
import { MAX_LIST_RESPONSE_BYTES } from "../../shared/constants.js";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface OpenAIModelListResponse {
  data?: Array<{ id: string; owned_by?: string }>;
}

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: { role?: string; content?: string | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerType = "openai_compatible" as const;

  baseUrlFor(credential: UpstreamCredential): string {
    return credential.baseUrl || DEFAULT_BASE_URL;
  }

  async listModels(credential: UpstreamCredential): Promise<ProviderModel[]> {
    const baseUrl = this.baseUrlFor(credential);
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${credential.apiKey}` },
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI listModels failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const raw = await response.text();
    if (raw.length > MAX_LIST_RESPONSE_BYTES) {
      throw new Error(`OpenAI listModels response too large (${raw.length} bytes)`);
    }
    const data = JSON.parse(raw) as OpenAIModelListResponse;
    return (data.data ?? []).map(m => ({
      id: m.id,
      name: m.id,
      displayName: m.id,
      capabilities: { ownedBy: m.owned_by }
    }));
  }

  buildUrl(credential: UpstreamCredential, path: string): string {
    // Gemini-style /v1beta/models/{model}:generateContent -> /v1/chat/completions
    void path;
    return `${this.baseUrlFor(credential)}/v1/chat/completions`;
  }

  buildHeaders(credential: UpstreamCredential): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${credential.apiKey}`
    };
  }

  transformRequest(request: GenerateRequest): unknown {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemInstruction) {
      const sysText = extractText(request.systemInstruction);
      if (sysText) messages.push({ role: "system", content: sysText });
    }

    for (const content of request.contents ?? []) {
      const role = content.role === "model" ? "assistant" : (content.role ?? "user");
      const text = extractText(content);
      if (text !== null) messages.push({ role, content: text });
    }

    const body: Record<string, unknown> = { model: request.model, messages };
    if (request.generationConfig) {
      const gc = request.generationConfig;
      if (gc.temperature !== undefined) body.temperature = gc.temperature;
      if (gc.maxOutputTokens !== undefined) body.max_tokens = gc.maxOutputTokens;
      if (gc.topP !== undefined) body.top_p = gc.topP;
      if (gc.stopSequences?.length) body.stop = gc.stopSequences;
    }

    return body;
  }

  transformResponse(response: unknown): GenerateResponse {
    const r = response as OpenAIChatResponse;
    return {
      candidates: (r.choices ?? []).map((choice, i) => ({
        content: {
          parts: [{ text: choice.message?.content ?? "" }],
          role: choice.message?.role ?? "model"
        },
        finishReason: mapFinishReason(choice.finish_reason),
        index: choice.index ?? i
      })),
      usageMetadata: r.usage
        ? {
            promptTokenCount: r.usage.prompt_tokens ?? 0,
            candidatesTokenCount: r.usage.completion_tokens ?? 0,
            totalTokenCount: r.usage.total_tokens ?? 0
          }
        : undefined,
      modelVersion: r.model
    };
  }

  classifyError(body: unknown, statusCode: number): ReturnType<typeof classifyUpstreamError> {
    return classifyUpstreamError(statusCode, body, "openai_compatible");
  }
}

function extractText(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { parts?: Array<{ text?: string }> };
  if (Array.isArray(c.parts)) {
    return c.parts.map(p => p.text ?? "").join("");
  }
  return null;
}

function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "stop": return "STOP";
    case "length": return "MAX_TOKENS";
    case "content_filter": return "SAFETY";
    default: return reason ? reason.toUpperCase() : "STOP";
  }
}
