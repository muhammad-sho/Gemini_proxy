import type { GenerateRequest, GenerateResponse } from "../../domain/providers/adapter.js";
import type { ChatCompletionCreate, ChatMessage } from "../../shared/validation.js";

/**
 * Translation between the OpenAI chat-completion wire format and the proxy's
 * canonical Gemini-shaped internal request/response. The OpenAI gateway
 * accepts OpenAI bodies only — every upstream provider (including native
 * Gemini pools) is reached through the same routing service the Gemini
 * gateway uses, so translation happens exactly here.
 */

export interface ChatChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function chatRequestToGenerate(input: ChatCompletionCreate): GenerateRequest {
  const systemParts: string[] = [];
  const contents: GenerateRequest["contents"] = [];

  const textOf = (message: ChatMessage): string =>
    typeof message.content === "string" ? message.content : "";

  for (const message of input.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message);
      if (text) systemParts.push(text);
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text: textOf(message) }] });
  }

  return {
    model: input.model,
    contents,
    generationConfig: {
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.top_p !== undefined ? { topP: input.top_p } : {}),
      ...(input.max_completion_tokens !== undefined || input.max_tokens !== undefined
        ? { maxOutputTokens: input.max_completion_tokens ?? input.max_tokens }
        : {}),
      ...(input.stop !== undefined
        ? { stopSequences: Array.isArray(input.stop) ? input.stop : [input.stop] }
        : {})
    },
    ...(systemParts.length > 0 ? { systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] } } : {})
  };
}

function mapFinishReason(reason: string | undefined): string | null {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
      return "content_filter";
    case "RECITATION":
      return "stop";
    default:
      return null;
  }
}

export function generateResponseToChat(
  gemini: GenerateResponse,
  requestedModel: string,
  id: string = `chatcmpl-${crypto.randomUUID()}`
): ChatCompletionResponse {
  const candidates = gemini.candidates ?? [];
  const promptTokens = gemini.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens =
    gemini.usageMetadata?.candidatesTokenCount ??
    candidates.reduce((sum, c) => sum + (c.content?.parts ?? []).reduce((n, p) => n + (p.text?.length ?? 0), 0), 0);

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: candidates.map((candidate, index) => ({
      index,
      message: {
        role: "assistant",
        content: (candidate.content?.parts ?? []).map(part => part.text ?? "").join("")
      },
      finish_reason: mapFinishReason(candidate.finishReason)
    })),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: gemini.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens
    }
  };
}

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    code: number;
  };
}

/** Map an upstream failure (already classified by status) into OpenAI's error envelope. */
export function upstreamErrorToChat(status: number, body: unknown): OpenAiErrorBody {
  let message = "Upstream request failed";
  if (body && typeof body === "object") {
    const b = body as { error?: { message?: string } | string; message?: string };
    if (typeof b.error === "string") message = b.error;
    else if (b.error?.message) message = b.error.message;
    else if (b.message) message = b.message;
  }

  let type = "api_error";
  if (status === 401 || status === 403) type = "authentication_error";
  else if (status === 400 || status === 404) type = "invalid_request_error";
  else if (status === 429) type = "rate_limit_error";

  return { error: { message, type, code: status } };
}
