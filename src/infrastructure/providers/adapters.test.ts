import { describe, it, expect, vi, afterEach } from "vitest";
import { GeminiAdapter } from "./gemini.adapter.js";
import { OpenAICompatibleAdapter } from "./openai-compatible.adapter.js";
import { MAX_LIST_RESPONSE_BYTES } from "../../shared/constants.js";

const geminiCred = { id: "p1", provider: "gemini" as const, apiKey: "KEY", baseUrl: "http://up.test" };
const openaiCred = { id: "p2", provider: "openai_compatible" as const, apiKey: "KEY", baseUrl: "http://up.test" };

function respond(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, text: async () => body })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gemini adapter", () => {
  it("lists models, stripping the models/ prefix", async () => {
    respond(200, JSON.stringify({
      models: [
        { name: "models/gemini-2.0-flash", displayName: "Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embed", displayName: "Embed" }
      ]
    }));
    const models = await new GeminiAdapter().listModels(geminiCred);
    expect(models.map(m => m.id)).toEqual(["gemini-2.0-flash", "text-embed"]);
    expect(models[0].capabilities).toMatchObject({ supportedGenerationMethods: ["generateContent"] });
  });

  it("rejects oversized model-list responses", async () => {
    respond(200, "x".repeat(MAX_LIST_RESPONSE_BYTES + 1));
    await expect(new GeminiAdapter().listModels(geminiCred)).rejects.toThrow(/too large/);
  });

  it("buildUrls against the credential base and forwards errors verbatim on failure", async () => {
    const adapter = new GeminiAdapter();
    expect(adapter.buildUrl(geminiCred, "/v1beta/models/m:generateContent")).toBe("http://up.test/v1beta/models/m:generateContent");
    respond(500, "boom");
    await expect(adapter.listModels(geminiCred)).rejects.toThrow(/\(500\)/);
  });
});

describe("openai-compatible adapter", () => {
  it("lists models from data[]", async () => {
    respond(200, JSON.stringify({ data: [{ id: "gpt-x", owned_by: "you" }] }));
    const models = await new OpenAICompatibleAdapter().listModels(openaiCred);
    expect(models[0]).toMatchObject({ id: "gpt-x", displayName: "gpt-x", capabilities: { ownedBy: "you" } });
  });

  it("routes every generation call to /v1/chat/completions", () => {
    expect(new OpenAICompatibleAdapter().buildUrl(openaiCred, "/v1beta/models/x:generateContent"))
      .toBe("http://up.test/v1/chat/completions");
  });

  it("translates requests and responses including usage metadata", () => {
    const adapter = new OpenAICompatibleAdapter();
    const req = adapter.transformRequest({
      model: "m",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "sys" }] },
      generationConfig: { temperature: 0.3, maxOutputTokens: 64, topP: 0.9, stopSequences: ["END"] }
    }) as Record<string, unknown>;
    expect(req.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" }
    ]);
    expect(req).toMatchObject({ model: "m", temperature: 0.3, max_tokens: 64, top_p: 0.9, stop: ["END"] });

    const res = adapter.transformResponse({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "yo" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      model: "m-v1"
    });
    expect(res.candidates[0].content.parts[0].text).toBe("yo");
    expect(res.usageMetadata).toEqual({ promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 });

    expect(adapter.classifyError({}, 401)).toBe("invalid_key");
  });
});
