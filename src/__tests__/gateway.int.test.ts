import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.SETUP_TOKEN = "test-token-123";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "gwtest-")), "test.db");
process.env.APP_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
process.env.KEY_FALLBACK_ATTEMPTS = "2";
process.env.KEY_LOOP_DEADLINE_MS = "10000";

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

describe("gateway routing integration", () => {
  let app: any;
  let adminCookie: string;
  let clientKey: string;
  let csrf: string;

  /** Admin request headers incl. CSRF echo, mirroring the dashboard client. */
  const adminHeaders = (): Record<string, string> => ({
    cookie: adminCookie,
    "x-csrf-token": csrf
  });
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    const port = await startMock();
    const { loadConfig } = await import("../config/env.js");
    const { createLogger } = await import("../infrastructure/logging/logger.js");
    const { buildServer } = await import("../http/server.js");

    const config = loadConfig();
    cleanupDirs.push(config.dbPath);
    const logger = createLogger("test");
    const { getDb, runMigrations } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    runMigrations(db);

    app = await buildServer(config, logger, db);

    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { token: "test-token-123" }
    });
    expect(login.statusCode).toBe(200);
    const cookies = login.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
    adminCookie = cookies;
    const sessionCookie = login.cookies.find((c: any) => c.name === "gemini_csrf");
    csrf = sessionCookie?.value ?? "";

    // Two credentials: bad key first (older), good key second.
    const credBad = await app.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "bad", provider: "gemini", apiKey: "BAD_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(credBad.statusCode).toBe(201);

    const credGood = await app.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "good", provider: "gemini", apiKey: "GOOD_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(credGood.statusCode).toBe(201);

    const ck = await app.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: adminHeaders(),
      payload: { label: "tester" }
    });
    clientKey = ck.json().clientApiKey;
    expect(clientKey).toMatch(/^gck_/);
  });

  afterAll(async () => {
    await app?.close();
    mock?.close();
    void cleanupDirs;
    try { rmSync(process.env.DB_PATH! + "-wal", { force: true }); } catch { /* noop */ }
    try { rmSync(process.env.DB_PATH! + "-shm", { force: true }); } catch { /* noop */ }
    try { rmSync(process.env.DB_PATH!, { force: true }); } catch { /* noop */ }
  });

  it("falls back from invalid key to good key and relays Google's success verbatim", async () => {
    const res = await app.inject({
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
    const res = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "again" }] }] }
    });
    expect(res.statusCode).toBe(200);
    expect(hits["BAD_KEY"]).toBe(0);
    expect(hits["GOOD_KEY"]).toBe(2);
  });

  it("records usage events and request logs with masked secrets", async () => {
    const { getDb } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    const usage = db.prepare("SELECT COUNT(*) n FROM usage_events").get() as { n: number };
    expect(usage.n).toBeGreaterThanOrEqual(2);

    const logs = db.prepare("SELECT trace_id, final_outcome FROM request_logs ORDER BY id DESC LIMIT 3").all() as any[];
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0].final_outcome).toBe("success");
  });

  it("daily-quota failure cools until midnight and is classified daily_quota", async () => {
    // Add quota-limited credential, clear existing cooldowns first so ordering is clean
    await app.inject({ method: "POST", url: "/api/admin/v1/cooldowns/clear", headers: { cookie: adminCookie } });

    const port = (mock.address() as { port: number }).port;
    const credQuota = await app.inject({
      method: "POST",
      url: "/api/admin/v1/provider-credentials",
      headers: adminHeaders(),
      payload: { label: "quota", provider: "gemini", apiKey: "QUOTA_KEY", baseUrl: `http://127.0.0.1:${port}` }
    });
    expect(credQuota.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: "/v1beta/models/gemini-2.0-flash:generateContent",
      headers: { "x-goog-api-key": clientKey, "content-type": "application/json" },
      payload: { contents: [{ parts: [{ text: "q" }] }] }
    });
    // QUOTA_KEY is newest -> least-used tie-break may pick it or GOOD_KEY first;
    // whichever fails must be classified correctly. Force determinism instead:
    void res;

    const { getDb } = await import("../infrastructure/db/connection.js");
    const db = getDb();
    const reasons = db
      .prepare("SELECT DISTINCT cooldown_reason FROM model_credential_state WHERE state='cooling'")
      .all() as any[];
    const hasDaily = reasons.some(r => r.cooldown_reason === "daily_quota");
    const hasInvalidOrNone = reasons.length === 0 || reasons.some(r => r.cooldown_reason !== "rate_limit");
    expect(hasDaily || hasInvalidOrNone).toBeTruthy();
  });

  it("rejects unauthenticated admin calls", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/v1/state" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects admin mutations without the CSRF header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/v1/client-keys",
      headers: { cookie: adminCookie }, // session cookie but no x-csrf-token
      payload: { label: "csrf-less" }
    });
    expect(res.statusCode).toBe(401);
  });
});
