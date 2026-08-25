import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dataDir = mkdtempSync(join(tmpdir(), "gwtest-"));
process.env.DATA_DIR = dataDir;
process.env.TRUST_PROXY = "true";

const ADMIN_PASSWORD = "test-admin-password";

/** Cast an inject() response body to the expected shape (test-side only). */
function json<T>(res: { json(): unknown }): T {
  return res.json() as T;
}

interface Cookie { name: string; value: string }
interface ClientKeyRow { id: string; label: string; allowedModels: string[]; allowedGroups: string[] }
interface GroupRow { id: string; pairs: Array<{ credentialId: string; modelId: string }>; routingStrategy: string }
interface CoolingReasonRow { cooldown_reason: string | null }

const hits: Record<string, number> = {};

let mock: Server;

async function startMock(): Promise<number> {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const auth = String(req.headers["x-goog-api-key"] ?? "");

      // Model listing (triggered by credential creation/probing) — not counted
      // as routing attempts. Must not swallow /models/{model}:action URLs.
      // An invalid upstream key is rejected, like the real API.
      if (req.url?.startsWith("/v1beta/models") && !req.url.includes(":")) {
        if (auth === "BAD_KEY") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 400, message: "API key not valid." } }));
          return;
        }
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
      if (req.url?.includes(":countTokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ totalTokens: 9 }));
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
  let adminApp: import("../http/server.js").AppServers["admin"];
  let geminiApp: import("../http/server.js").AppServers["gemini"];
  let openaiApp: import("../http/server.js").AppServers["openai"];
  let adminCookie: string;
  let csrf: string;
  let clientKey: string;
  let goodCredentialId = "";

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
    const cookies = setup.cookies.map((c: Cookie) => `${c.name}=${c.value}`).join("; ");
    adminCookie = cookies;
    const sessionCookie = setup.cookies.find((c: Cookie) => c.name.endsWith("gemini_csrf"));
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

    // Two credentials: bad key first (older), good key second. Selected models
    // define what each credential can serve (live retrieval is never stored).
    const credBad = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "bad", provider: "gemini", apiKey: "BAD_KEY", baseUrl: `http://127.0.0.1:${port}`, allowedModels: ["gemini-2.0-flash"] }
    });
    expect(credBad.statusCode).toBe(201);

    const credGood = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: {
        label: "good", provider: "gemini", apiKey: "GOOD_KEY",
        baseUrl: `http://127.0.0.1:${port}`,
        allowedModels: ["gemini-2.0-flash", "mock-probe"]
      }
    });
    expect(credGood.statusCode).toBe(201);
    goodCredentialId = credGood.json().id;

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

  it("rejects unsupported actions", async () => {
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:streamGenerateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: {}
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/generateContent/);
  });

  it("proxies countTokens through native Gemini credentials", async () => {
    const beforeGood = hits.GOOD_KEY ?? 0;
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:countTokens",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "count me" }] }] }
    });
    expect(res.statusCode).toBe(200);
    expect(json<{ totalTokens: number }>(res).totalTokens).toBe(9);
    expect(hits.GOOD_KEY ?? 0).toBe(beforeGood + 1); // routed via the native credential
  });

  it("puts the invalid key into cooldown", async () => {
    const { getDb } = await import("../infrastructure/db/connection.js");
    const rows = getDb()
      .prepare("SELECT state, cooldown_reason FROM model_credential_state WHERE model_id = 'gemini-2.0-flash'")
      .all() as Array<{ state: string; cooldown_reason: string | null }>;
    const bad = rows.find(r => r.cooldown_reason === "invalid_key");
    expect(bad?.state).toBe("cooling");
  });

  it("second request skips the cooled key entirely", async () => {
    hits.BAD_KEY = 0;
    const beforeGood = hits.GOOD_KEY ?? 0;
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "again" }] }] }
    });
    expect(res.statusCode).toBe(200);
    expect(hits["BAD_KEY"]).toBe(0);
    expect(hits.GOOD_KEY ?? 0).toBe(beforeGood + 1);
  });

  it("records usage events and request logs", async () => {
    const { getDb } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    const usage = db.prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number };
    expect(usage.n).toBeGreaterThanOrEqual(2);

    const logs = db.prepare("SELECT trace_id, final_outcome FROM request_logs ORDER BY id DESC LIMIT 3").all() as Array<{ final_outcome: string }>;
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
      payload: { label: "quota", provider: "gemini", apiKey: "QUOTA_KEY", baseUrl: `http://127.0.0.1:${port}`, allowedModels: ["gemini-2.0-flash"] }
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
      .all() as CoolingReasonRow[];
    expect(reasons.some(r => r.cooldown_reason === "daily_quota")).toBe(true);
  });

  // ---- Groups and live model probing ----

  it("probes models live for the add form and per stored credential", async () => {
    const port = (mock.address() as { port: number }).port;

    const probe = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-models/probe",
      headers: adminHeaders(),
      payload: { provider: "gemini", apiKey: "GOOD_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(probe.statusCode).toBe(200);
    expect(probe.json<{ models: Array<{ id: string }> }>().models.some(m => m.id === "mock-probe")).toBe(true);

    const probeBad = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-models/probe",
      headers: adminHeaders(),
      payload: { provider: "gemini", apiKey: "BAD_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(probeBad.statusCode).toBe(502);

    const stored = await adminApp.inject({
      method: "GET",
      url: `/api/admin/v1/provider-credentials/${goodCredentialId}/models`,
      headers: { cookie: adminCookie }
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json<{ models: Array<{ id: string }> }>().models.some(m => m.id === "mock-probe")).toBe(true);
  });

  it("derives the model list from selected credentials and serves OpenAI format", async () => {
    const res = await openaiApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${clientKey}` }
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json<{ data: Array<{ id: string }> }>().data.map(m => m.id);
    expect(ids).toContain("gemini-2.0-flash");
    expect(ids).toContain("mock-probe");

    const geminiList = await geminiApp.inject({
      method: "GET",
      url: "/v1beta/models",
      headers: { "x-goog-api-key": clientKey }
    });
    expect(geminiList.statusCode).toBe(200);
    expect(geminiList.json<{ models: Array<{ name: string }> }>().models.some(m => m.name === "models/mock-probe")).toBe(true);
  });

  it("creates a group over key×model pairs, routes through it with its strategy, and scopes candidates", async () => {
    // Group containing ONLY the good credential for this model.
    const created = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/groups",
      headers: adminHeaders(),
      payload: {
        name: "fast-tier",
        description: "fast keys only",
        routingStrategy: "round_robin",
        fallbackStrategy: "least_used",
        pairs: [{ credentialId: goodCredentialId, modelId: "gemini-2.0-flash" }]
      }
    });
    expect(created.statusCode).toBe(201);
    const group = created.json();
    expect(group.pairs).toHaveLength(1);

    // Duplicate name is rejected
    const dup = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/groups",
      headers: adminHeaders(),
      payload: { name: "fast-tier", routingStrategy: "least_used", pairs: [] }
    });
    expect(dup.statusCode).toBe(409);

    // Client key assigned to the group can use the model via the group's
    // candidate scope — the bad credential is not part of the group.
    hits.BAD_KEY = 0;
    const ckGroup = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: adminHeaders(),
      payload: { label: "grouped", allowedGroups: ["fast-tier"] }
    });
    const groupedKey = ckGroup.json().clientApiKey;

    const before = hits.GOOD_KEY ?? 0;
    const res = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": groupedKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "via group" }] }] }
    });
    expect(res.statusCode).toBe(200);
    expect(hits.BAD_KEY).toBe(0);
    expect(hits.GOOD_KEY).toBe(before + 1);

    // A model not present in any of the group's pairs is denied.
    await adminApp.inject({
      method: "PUT",
      url: `/api/admin/v1/groups/${group.id}`,
      headers: adminHeaders(),
      payload: { pairs: [{ credentialId: goodCredentialId, modelId: "other-model" }] }
    });
    const denied = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": groupedKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "nope" }] }] }
    });
    expect(denied.statusCode).toBe(403);

    // Cleanup: restore pairs so later tests are unaffected
    await adminApp.inject({
      method: "PUT",
      url: `/api/admin/v1/groups/${group.id}`,
      headers: adminHeaders(),
      payload: { pairs: [{ credentialId: goodCredentialId, modelId: "gemini-2.0-flash" }] }
    });

    const deleted = await adminApp.inject({
      method: "DELETE",
      url: `/api/admin/v1/groups/${group.id}`,
      headers: adminHeaders()
    });
    expect(deleted.statusCode).toBe(200);
  });

  it("updates client-key permissions", async () => {
    const ck = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: adminHeaders(),
      payload: { label: "editable" }
    });
    const id = ck.json().id;
    const updated = await adminApp.inject({
      method: "PUT",
      url: `/api/admin/v1/client-keys/${id}`,
      headers: adminHeaders(),
      payload: { allowedModels: ["gemini-2.0-flash"] }
    });
    expect(updated.statusCode).toBe(200);

    const state = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/state",
      headers: { cookie: adminCookie }
    });
    const key = json<{ clientKeys: ClientKeyRow[] }>(state).clientKeys.find(k => k.id === id)!;
    expect(key.allowedModels).toEqual(["gemini-2.0-flash"]);
  });

  it("cleans up references on renames/deletes and returns a normalized 503 envelope", async () => {
    const port = (mock.address() as { port: number }).port;

    // Scratch credential whose deletion must cascade out of the group.
    const scratch = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: {
        label: "scratch", provider: "gemini", apiKey: "SCRATCH_KEY",
        baseUrl: `http://127.0.0.1:${port}`, allowedModels: ["mock-probe"]
      }
    });
    const scratchId = scratch.json().id;

    let group = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/groups",
      headers: adminHeaders(),
      payload: {
        name: "integrity",
        routingStrategy: "least_used",
        pairs: [
          { credentialId: goodCredentialId, modelId: "mock-probe" },
          { credentialId: scratchId, modelId: "mock-probe" }
        ]
      }
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json().id;

    const ck = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: adminHeaders(),
      payload: { label: "ref-key", allowedGroups: ["integrity"] }
    });
    const refKeyId = ck.json().id;

    // Deleting the scratch credential removes its ghost pairs from the group.
    const del = await adminApp.inject({
      method: "DELETE",
      url: `/api/admin/v1/provider-credentials/${scratchId}`,
      headers: adminHeaders()
    });
    expect(del.statusCode).toBe(200);
    group = await adminApp.inject({ method: "GET", url: "/api/admin/v1/groups", headers: { cookie: adminCookie } });
    const afterDelete = json<GroupRow[]>(group).find(g => g.id === groupId)!;
    expect(afterDelete.pairs).toHaveLength(1);
    expect(afterDelete.pairs[0].credentialId).toBe(goodCredentialId);

    // Renaming the group rewrites client-key references.
    const renamed = await adminApp.inject({
      method: "PUT",
      url: `/api/admin/v1/groups/${groupId}`,
      headers: adminHeaders(),
      payload: { name: "integrity-renamed" }
    });
    expect(renamed.statusCode).toBe(200);
    let state = await adminApp.inject({ method: "GET", url: "/api/admin/v1/state", headers: { cookie: adminCookie } });
    expect(json<{ clientKeys: ClientKeyRow[] }>(state).clientKeys.find(k => k.id === refKeyId)!.allowedGroups)
      .toEqual(["integrity-renamed"]);

    // A group pair pointing at a nonexistent credential yields the unified
    // 503 envelope (code + message + requestId), not a bare string error.
    await adminApp.inject({
      method: "PUT",
      url: `/api/admin/v1/groups/${groupId}`,
      headers: adminHeaders(),
      payload: { pairs: [{ credentialId: "pc_ghost-credential", modelId: "gemini-2.0-flash" }] }
    });
    const orphan = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: {}
    });

    // The main client key has no group for this model → normal routing applies;
    // use the ref key (group-scoped) to hit the orphaned plan instead.
    const groupedKey = ck.json().clientApiKey;
    void orphan;
    const res503 = await geminiApp.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": groupedKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "orphan" }] }] }
    });
    expect(res503.statusCode).toBe(503);
    const errBody = res503.json();
    expect(errBody.error.code).toBe(503);
    expect(typeof errBody.error.message).toBe("string");
    expect(errBody.error.requestId).toBeTruthy();

    // Deleting the group strips its name from the client key.
    const delGroup = await adminApp.inject({
      method: "DELETE",
      url: `/api/admin/v1/groups/${groupId}`,
      headers: adminHeaders()
    });
    expect(delGroup.statusCode).toBe(200);
    state = await adminApp.inject({ method: "GET", url: "/api/admin/v1/state", headers: { cookie: adminCookie } });
    expect(json<{ clientKeys: ClientKeyRow[] }>(state).clientKeys.find(k => k.id === refKeyId)!.allowedGroups).toEqual([]);
  });

  it("stores token counts from upstream usageMetadata and aggregates them", async () => {
    const { getDb } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    const latest = db.prepare(
      "SELECT request_tokens, response_tokens FROM usage_events ORDER BY id DESC LIMIT 1"
    ).get() as { request_tokens: number | null; response_tokens: number | null };
    // Mock upstream always answers with prompt=2 / completion=5
    expect(latest.request_tokens).toBe(2);
    expect(latest.response_tokens).toBe(5);

    const summary = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/usage-summary?days=7",
      headers: { cookie: adminCookie }
    });
    expect(summary.statusCode).toBe(200);
    const body = json<{
      days: number;
      keys: Array<{ id: string; label: string }>;
      models: Array<{ id: string }>;
      cells: Array<{ providerId: string; modelId: string; requests: number }>;
      states: Array<{ credentialId: string; modelId: string; state: string; errorCount: number }>;
    }>(summary);
    expect(body.days).toBe(7);
    expect(body.keys.length).toBeGreaterThanOrEqual(2);
    expect(body.models.some(m => m.id === "gemini-2.0-flash")).toBe(true);

    const flashCell = body.cells.find(c => c.modelId === "gemini-2.0-flash");
    expect(flashCell).toBeDefined();
    expect(flashCell!.requests).toBeGreaterThan(0);

    const goodState = body.states.find(
      st => st.credentialId === goodCredentialId && st.modelId === "gemini-2.0-flash"
    );
    expect(goodState).toBeDefined();
    expect(["ready", "cooling"]).toContain(goodState!.state);
  });

  it("upgrades to __Host- cookies over HTTPS and leaves HSTS off by default", async () => {
    // HSTS is opt-in (HSTS=true) — plain HTTP responses must not send it.
    const health = await adminApp.inject({ method: "GET", url: "/health/live" });
    expect(health.headers["strict-transport-security"]).toBeUndefined();

    const httpsLogin = await adminApp.inject({
      method: "POST",
      url: "/api/admin/v1/login",
      headers: { "x-forwarded-proto": "https", "content-type": "application/json" },
      payload: { token: ADMIN_PASSWORD }
    });
    expect(httpsLogin.statusCode).toBe(200);
    expect(httpsLogin.headers["strict-transport-security"]).toBeUndefined();

    const names = httpsLogin.cookies.map((c: Cookie) => c.name);
    expect(names).toContain("__Host-gemini_admin_session");
    expect(names).toContain("__Host-gemini_csrf");

    // The prefixed session authenticates normally.
    const session = httpsLogin.cookies.find((c: Cookie) => c.name === "__Host-gemini_admin_session")!;
    const res = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/state",
      headers: {
        cookie: `${session.name}=${session.value}`,
        "x-forwarded-proto": "https"
      }
    });
    expect(res.statusCode).toBe(200);
  });

  it("rate-limits repeated credential attempts on a dedicated auth bucket", async () => {
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await adminApp.inject({
        method: "POST",
        url: "/api/admin/v1/login",
        payload: { token: "definitely-wrong" }
      });
      if (res.statusCode === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
  });

  it("exposes health checks and the security log", async () => {
    const live = await adminApp.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(json<{ status: string }>(live).status).toBe("ok");

    const ready = await adminApp.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(json<{ checks: Record<string, boolean> }>(ready).checks.database).toBe(true);

    const audit = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/audit-logs?limit=10",
      headers: { cookie: adminCookie }
    });
    expect(audit.statusCode).toBe(200);
    const body = json<{
      total: number;
      actions: string[];
      logs: Array<{ action: string; entityType: string | null; entityId: string | null }>;
    }>(audit);
    expect(body.total).toBeGreaterThan(0);
    expect(body.actions).toContain("setup");
    // The integrity test above performed group updates/deletes — all audited.
    expect(body.logs.some(l => l.action === "delete" && l.entityType === "group")).toBe(true);

    // Action filter narrows results.
    const filtered = await adminApp.inject({
      method: "GET",
      url: "/api/admin/v1/audit-logs?action=setup",
      headers: { cookie: adminCookie }
    });
    const filteredBody = json<{ total: number; logs: Array<{ action: string }> }>(filtered);
    expect(filteredBody.total).toBe(1);
    expect(filteredBody.logs.every(l => l.action === "setup")).toBe(true);
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
    expect(json<{ data: Array<{ id: string }> }>(res).data.some(m => m.id === "mock-probe")).toBe(true);
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
    expect(list.json<{ data: Array<{ id: string }> }>().data.some(m => m.id === "mock-probe")).toBe(false);
  });
});
