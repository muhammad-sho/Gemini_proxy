import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dataDir = mkdtempSync(join(tmpdir(), "gwtest-"));
process.env.DATA_DIR = dataDir;

const ADMIN_PASSWORD = "test-admin-password";

const hits: Record<string, number> = {};

let mock: Server;

async function startMock(): Promise<number> {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const auth = String(req.headers["x-goog-api-key"] ?? "");

      // Model listing (triggered by credential creation) — not counted as
      // routing attempts. Must not swallow /models/{model}:action URLs.
      if (req.url?.startsWith("/v1beta/models") && !req.url.includes(":")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "models/mock-probe", displayName: "Mock Probe" }] }));
        return;
      }

      hits[auth] = (hits[auth] ?? 0) + 1;

      if (auth === "BAD_KEY") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" }
        }));
        return;
      }
      if (auth === "QUOTA_KEY") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: { code: 429, message: "Generate requests per day limit reached for this project." }
        }));
        return;
      }
      if (req.url?.includes(":generateContent")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: `hello-from-${auth}` }], role: "model" }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 5, totalTokenCount: 7 }
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  return (mock.address() as { port: number }).port;
}

describe("split gateway surfaces", () => {
  let adminApp: any;
  let geminiApp: any;
  let openaiApp: any;
  let adminCookie: string;
  let csrf: string;
  let clientKey: string;

  /** Admin request headers incl. CSRF echo, mirroring the dashboard client. */
  const adminHeaders = (): Record<string, string> => ({
    cookie: adminCookie,
    "x-csrf-token": csrf
  });

  beforeAll(async () => {
    const port = await startMock();
    const { loadConfig } = await import("../config/env.js");
    const { createLogger } = await import("../infrastructure/logging/logger.js");
    const { buildServers } = await import("../http/server.js");

    const config = loadConfig();
    const logger = createLogger("test");
    const { getDb, runMigrations } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    runMigrations(db);

    const servers = await buildServers(config, logger, db);
    adminApp = servers.admin;
    geminiApp = servers.gemini;
    openaiApp = servers.openai;

    // First-run setup flow
    const statusBefore = await adminApp.inject({ method: "GET", url: "/api/admin/v1/setup/status" });
    expect(statusBefore.json()).toEqual({ setupRequired: true });

    const tooShort = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/setup",
      payload: { password: "short" }
    });
    expect(tooShort.statusCode).toBe(400);

    const setup = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/setup",
      payload: { password: ADMIN_PASSWORD }
    });
    expect(setup.statusCode).toBe(200);
    const cookies = setup.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    adminCookie = cookies;
    const sessionCookie = setup.cookies.find((c: any) => c.name === "gemini_csrf");
    csrf = sessionCookie?.value ?? "";

    const statusAfter = await adminApp.inject({ method: "GET", url: "/api/admin/v1/setup/status" });
    expect(statusAfter.json()).toEqual({ setupRequired: false });

    // Setup is one-time only
    const secondSetup = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/setup",
      payload: { password: ADMIN_PASSWORD }
    });
    expect(secondSetup.statusCode).toBe(409);

    const login = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/login",
      payload: { token: ADMIN_PASSWORD }
    });
    expect(login.statusCode).toBe(200);

    const badLogin = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/login",
      payload: { token: "wrong-password" }
    });
    expect(badLogin.statusCode).toBe(401);

    // Two credentials: bad key first (older), good key second.
    const credBad = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "bad", provider: "gemini", apiKey: "BAD_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(credBad.statusCode).toBe(201);

    const credGood = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "good", provider: "gemini", apiKey: "GOOD_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(credGood.statusCode).toBe(201);

    const ck = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: adminHeaders(),
      payload: { label: "tester" }
    });
    clientKey = ck.json().clientApiKey;
    expect(clientKey).toMatch(/^gck_/);
  });

  afterAll(async () => {
    await adminApp?.close();
    await geminiApp?.close();
    await openaiApp?.close();
    mock?.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // ---- Gemini surface ----

  it("falls back from invalid key to good key and relays Google's success verbatim", async () => {
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "hi" }] }] }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidates[0].content.parts[0].text).toBe("hello-from-GOOD_KEY");
    expect(hits["BAD_KEY"]).toBeGreaterThanOrEqual(1);
    expect(hits["GOOD_KEY"]).toBe(1);
  });

  it("rejects non-generateContent actions", async () => {
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:countTokens",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: {}
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/generateContent/);
  });

  it("puts the invalid key into cooldown", async () => {
    const { getDb } = await import("../infrastructure/db/connection.js");
    const rows = getDb()
      .prepare("SELECT state, cooldown_reason FROM model_credential_state WHERE model_id = 'gemini-2.0-flash'")
      .all() as any[];
    const bad = rows.find(r => r.cooldown_reason === "invalid_key");
    expect(bad?.state).toBe("cooling");
  });

  it("second request skips the cooled key entirely", async () => {
    hits.BAD_KEY = 0;
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "again" }] }] }
    });
    expect(res.statusCode).toBe(200);
    expect(hits["BAD_KEY"]).toBe(0);
    expect(hits["GOOD_KEY"]).toBe(2);
  });

  it("records usage events and request logs", async () => {
    const { getDb } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    const usage = db.prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number };
    expect(usage.n).toBeGreaterThanOrEqual(2);

    const logs = db.prepare("SELECT trace_id, final_outcome FROM request_logs ORDER BY id DESC LIMIT 3").all() as any[];
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0].final_outcome).toBe("success");
  });

  it("daily-quota failure is classified daily_quota and cools the key", async () => {
    // Clear existing cooldowns so ordering starts clean
    await adminApp.inject({ method: "POST", url: "/api/admin/v1/cooldowns/clear", headers: adminHeaders() });
    const port = (mock.address() as { port: number }).port;
    const credQuota = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "quota", provider: "gemini", apiKey: "QUOTA_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(credQuota.statusCode).toBe(201);

    // Drive requests until the QUOTA_KEY gets its attempt (least-used rotation
    // starts with the least-used credentials; QUOTA_KEY cools down when tried).
    for (let i = 0; i < 2; i++) {
      await geminiApp.inject({
        method: "POST",
        url: "/v1beta/models/gemini-2.0-flash:generateContent",
        headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
        payload: { contents: [{ parts: [{ text: "q" }] }] }
      });
    }

    const { getDb } = await import("../infrastructure/db/connection.js");
    const reasons = getDb()
      .prepare("SELECT DISTINCT cooldown_reason FROM model_credential_state WHERE state='cooling'")
      .all() as any[];
    expect(reasons.some(r => r.cooldown_reason === "daily_quota")).toBe(true);
  });

  // ---- Admin surface ----

  it("rejects unauthenticated admin calls", async () => {
    const res = await adminApp.inject({ method: "GET", url: "/api/admin/v1/state" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects admin mutations without the CSRF header", async () => {
    const res = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: { cookie: adminCookie }, // session cookie but no x-csrf-token
      payload: { label: "csrf-less" }
    });
    expect(res.statusCode).toBe(401);
  });

  // ---- Settings ----

  it("serves runtime settings: defaults, live update and validation", async () => {
    const unauth = await adminApp.inject({ method: "GET", url: "/api/admin/v1/settings" });
    expect(unauth.statusCode).toBe(401);

    const initial = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/settings",
      headers: { cookie: adminCookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ keyFallbackAttempts: 2, maxLogEntries: 1000 });

    const updated = await adminApp.inject({
      method: "PUT",
      url: "/api/admin/v1/settings",
      headers: adminHeaders(),
      payload: { keyFallbackAttempts: 3 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().keyFallbackAttempts).toBe(3);

    const reread = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/settings",
      headers: { cookie: adminCookie }
    });
    expect(reread.json().keyFallbackAttempts).toBe(3);

    const invalid = await adminApp.inject({
      method: "PUT",
      url: "/api/admin/v1/settings",
      headers: adminHeaders(),
      payload: { keyFallbackAttempts: 99 }
    });
    expect(invalid.statusCode).toBe(400);

    // Restore default for later routing tests
    await adminApp.inject({
      method: "PUT",
      url: "/api/admin/v1/settings",
      headers: adminHeaders(),
      payload: { keyFallbackAttempts: 2 }
    });
  });

  // ---- OpenAI surface ----

  it("serves chat completions translated into OpenAI format", async () => {
    const res = await openaiApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
      payload: {
        model: "gemini-2.0-flash",
        messages: [
          { role: "system", content: "be nice" },
          { role: "user", content: "hi again" }
        ],
        temperature: 0.7,
        max_tokens: 50
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gemini-2.0-flash");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toContain("hello-from-GOOD_KEY");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("lists cached models in OpenAI format", async () => {
    const res = await openaiApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${clientKey}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(body.data.some((m: any) => m.id === "mock-probe")).toBe(true);
  });

  it("rejects missing/unknown bearer tokens with an OpenAI-shaped 401", async () => {
    const missing = await openaiApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: { model: "m", messages: [{ role: "user", content: "x" }] }
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.type).toBe("authentication_error");

    const bad = await openaiApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer gck_not-a-real-key" }
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.type).toBe("authentication_error");
  });

  it("rejects streaming requests until streaming ships", async () => {
    const res = await openaiApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
      payload: { model: "gemini-2.0-flash", messages: [{ role: "user", content: "x" }], stream: true }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("enforces client-key model allowlists on the OpenAI surface", async () => {
    const ck = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: adminHeaders(),
      payload: { label: "restricted", allowedModels: ["some-other-model"] }
    });
    const restrictedKey = ck.json().clientApiKey;

    const res = await openaiApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${restrictedKey}`, "content-type": "application/json" },
      payload: { model: "gemini-2.0-flash", messages: [{ role: "user", content: "x" }] }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.type).toBe("permission_error");

    const list = await openaiApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${restrictedKey}` }
    });
    expect(list.json().data.some((m: any) => m.id === "mock-probe")).toBe(false);
  });
});
