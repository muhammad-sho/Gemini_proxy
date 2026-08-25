import { describe, it, expect } from "vitest";
import type { GenerateResponse } from "../../domain/providers/adapter.js";
import {
  chatRequestToGenerate,
  generateResponseToChat,
  upstreamErrorToChat
} from "./openai.protocol.js";

describe("chatRequestToGenerate", () => {
  it("maps roles: system/developer to systemInstruction, assistant to model", () => {
    const result = chatRequestToGenerate({
      model: "gemini-2.0-flash",
      messages: [
        { role: "system", content: "be brief" },
        { role: "developer", content: "no markdown" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" }
      ]
    });

    expect(result.systemInstruction).toEqual({ parts: [{ text: "be brief\n\nno markdown" }] });
    expect(result.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
      { role: "user", parts: [{ text: "bye" }] }
    ]);
    expect(result.model).toBe("gemini-2.0-flash");
  });

  it("maps sampling options into generationConfig", () => {
    const result = chatRequestToGenerate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 128,
      stop: ["END"]
    });
    expect(result.generationConfig).toEqual({
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 128,
      stopSequences: ["END"]
    });
  });

  it("prefers max_completion_tokens and accepts string-or-array stop", () => {
    const a = chatRequestToGenerate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_completion_tokens: 64
    });
    expect(a.generationConfig?.maxOutputTokens).toBe(64);

    const b = chatRequestToGenerate({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stop: ["A", "B"]
    });
    expect(b.generationConfig?.stopSequences).toEqual(["A", "B"]);
  });

  it("omits empty system instruction and null-content messages produce empty text", () => {
    const result = chatRequestToGenerate({
      model: "m",
      messages: [{ role: "user", content: null }]
    });
    expect(result.systemInstruction).toBeUndefined();
    expect(result.contents).toEqual([{ role: "user", parts: [{ text: "" }] }]);
  });
});

function withFinish(base: GenerateResponse, finishReason: string): GenerateResponse {
  return { ...base, candidates: [{ ...base.candidates[0], finishReason }] };
}

function withoutUsage(base: GenerateResponse): GenerateResponse {
  return { candidates: base.candidates };
}

describe("generateResponseToChat", () => {
  const gemini: GenerateResponse = {
    candidates: [
      {
        content: { parts: [{ text: "Hello" }, { text: " world" }], role: "model" },
        finishReason: "STOP",
        index: 0
      }
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
  };

  it("joins parts, maps finish reason and usage", () => {
    const chat = generateResponseToChat(gemini, "my-model", "chatcmpl-test");
    expect(chat.id).toBe("chatcmpl-test");
    expect(chat.object).toBe("chat.completion");
    expect(chat.model).toBe("my-model");
    expect(chat.choices).toHaveLength(1);
    expect(chat.choices[0].message).toEqual({ role: "assistant", content: "Hello world" });
    expect(chat.choices[0].finish_reason).toBe("stop");
    expect(chat.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("generates an id when none supplied", () => {
    const chat = generateResponseToChat(gemini, "m");
    expect(chat.id).toMatch(/^chatcmpl-/);
  });

  it("maps MAX_TOKENS and SAFETY finish reasons", () => {
    const length = generateResponseToChat(
      withFinish(gemini, "MAX_TOKENS"),
      "m"
    );
    expect(length.choices[0].finish_reason).toBe("length");

    const safety = generateResponseToChat(
      withFinish(gemini, "SAFETY"),
      "m"
    );
    expect(safety.choices[0].finish_reason).toBe("content_filter");
  });

  it("falls back to character count when usageMetadata missing", () => {
    const chat = generateResponseToChat(withoutUsage(gemini), "m");
    expect(chat.usage.completion_tokens).toBe(11);
    expect(chat.usage.total_tokens).toBe(11);
  });
});

describe("upstreamErrorToChat", () => {
  it("extracts nested gemini error messages", () => {
    const body = upstreamErrorToChat(429, {
      error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" }
    });
    expect(body.error).toEqual({ message: "quota exceeded", type: "rate_limit_error", code: 429 });
  });

  it("classifies auth and request errors", () => {
    expect(upstreamErrorToChat(401, {}).error.type).toBe("authentication_error");
    expect(upstreamErrorToChat(400, { message: "bad body" }).error.type).toBe("invalid_request_error");
    expect(upstreamErrorToChat(500, {}).error.type).toBe("api_error");
  });

  it("keeps a generic message for unparseable bodies", () => {
    const body = upstreamErrorToChat(502, "not json");
    expect(body.error.message).toBe("Upstream request failed");
    expect(body.error.code).toBe(502);
  });
});
