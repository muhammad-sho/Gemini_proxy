export type ProviderType = "gemini" | "openai_compatible";

/** Minimal credential shape adapters need at call time. */
export interface UpstreamCredential {
  id: string;
  provider: ProviderType;
  apiKey: string;
  baseUrl: string | null;
}

export interface ProviderModel {
  id: string;
  name: string;
  displayName: string;
  capabilities: Record<string, unknown>;
}

export interface GenerateRequest {
  model: string;
  contents: any[];
  generationConfig?: any;
  safetySettings?: any[];
  tools?: any[];
  systemInstruction?: any;
}

export interface GenerateResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }>; role: string };
    finishReason: string;
    index: number;
    safetyRatings?: any[];
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
}

export type ErrorClassification =
  | "invalid_key"
  | "daily_quota"
  | "rate_limit"
  | "transient"
  | "permanent"
  | "unknown";

export interface ProviderAdapter {
  readonly providerType: ProviderType;
  baseUrlFor(credential: UpstreamCredential): string;
  listModels(credential: UpstreamCredential): Promise<ProviderModel[]>;
  buildUrl(credential: UpstreamCredential, path: string): string;
  buildHeaders(credential: UpstreamCredential): Record<string, string>;
  transformRequest(request: GenerateRequest): unknown;
  transformResponse(response: unknown): GenerateResponse;
  classifyError(body: unknown, statusCode: number): ErrorClassification;
}

const DAILY_MESSAGE_RE = /\b(per[_ ]?day|daily|requests per day|\brpd)\b/i;
const INVALID_KEY_MESSAGE_RE = /api[_ ]key[_ ](not[ _]valid|invalid)|invalid[ _]api[ _]key|api_key_invalid/i;

function looksLikeDailyQuota(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as {
    error?: { message?: string; details?: Array<{ "@type"?: string }> };
    message?: string;
  };
  const message = b.error?.message ?? b.message ?? "";
  if (DAILY_MESSAGE_RE.test(message)) return true;
  if (Array.isArray(b.error?.details)) {
    for (const detail of b.error!.details) {
      if (detail["@type"]?.includes("QuotaFailure")) {
        const serialized = JSON.stringify(detail).toLowerCase();
        if (serialized.includes("perday") || serialized.includes("per_day")) return true;
      }
    }
  }
  return false;
}

export function classifyUpstreamError(
  statusCode: number,
  body: unknown,
  _providerType: ProviderType
): ErrorClassification {
  const serialized = JSON.stringify(body ?? {});

  if (statusCode === 401 || statusCode === 403) {
    return "invalid_key";
  }

  if (statusCode === 400 && INVALID_KEY_MESSAGE_RE.test(serialized)) {
    // Gemini signals bad keys with 400 + API_KEY_INVALID / "API key not valid".
    return "invalid_key";
  }

  if (statusCode === 429) {
    if (looksLikeDailyQuota(body)) return "daily_quota";
    return "rate_limit";
  }

  if (statusCode >= 500 || statusCode === 408) return "transient";
  if (statusCode >= 400) return "permanent";
  return "unknown";
}
