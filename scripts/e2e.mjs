#!/usr/bin/env node
/**
 * End-to-end happy path against the BUILT app (run `npm run build` first).
 * Dependency-free: uses Node's built-in http/fetch only.
 *
 * Journey: boot on temp ports with a mock upstream → first-run setup → add a
 * provider key (live probe) → build a group → issue a client key → call both
 * gateways → verify usage metrics, logs and audit trail.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ADMIN_PORT = 18990;
const GEMINI_PORT = 18991;
const OPENAI_PORT = 18992;
const BASE = `http://127.0.0.1:${ADMIN_PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "e2e-"));

let failures = 0;
function check(name, ok, extra = "") {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

async function waitReady(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server never became ready at ${url}`);
}

function startMock() {
  return new Promise(resolve => {
    const mock = createServer((req, res) => {
      let raw = "";
      req.on("data", c => (raw += c));
      req.on("end", () => {
        const auth = String(req.headers["x-goog-api-key"] ?? "");
        if (req.url.startsWith("/v1beta/models") && !req.url.includes(":")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [
            { name: "models/gemini-2.0-flash", displayName: "Flash" },
            { name: "models/mock-probe", displayName: "Probe" }
          ] }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: `hello-from-${auth}` }], role: "model" }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 }
        }));
      });
    });
    mock.listen(0, "127.0.0.1", () => resolve(mock));
  });
}

const child = spawn(process.execPath, ["dist/main.js"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    DATA_DIR: dataDir,
    ADMIN_PORT: String(ADMIN_PORT),
    GEMINI_PORT: String(GEMINI_PORT),
    OPENAI_PORT: String(OPENAI_PORT),
    GATEWAY_HOST: "127.0.0.1",
    ADMIN_HOST: "127.0.0.1"
  },
  stdio: "ignore"
});

let mock;
let cookie = "";
let csrf = "";

async function api(method, path, body, headers = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (csrf && method !== "GET") h["x-csrf-token"] = csrf;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name.endsWith("gemini_admin_session")) {
      cookie = `${name}=${value}`;
    } else if (name.endsWith("gemini_csrf")) {
      csrf = value;
    }
  }
  return res;
}

try {
  mock = await startMock();
  const upstreamPort = mock.address().port;

  await waitReady(`${BASE}/health/ready`);
  console.log("e2e: server ready");

  // First-run setup
  const status = await (await api("GET", "/api/admin/v1/setup/status")).json();
  check("setup required on fresh install", status.setupRequired === true);
  check("setup succeeds", (await api("POST", "/api/admin/v1/setup", { password: "e2e-admin-pass" })).status === 200);

  // Add provider credential (selected models saved; probe is live-only)
  const credRes = await api("POST", "/api/admin/v1/provider-credentials", {
    label: "mock-upstream", provider: "gemini", apiKey: "E2E_UPSTREAM_KEY",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    allowedModels: ["gemini-2.0-flash", "mock-probe"]
  });
  check("credential created", credRes.status === 201);
  const credId = (await credRes.json()).id;

  const probed = await (await api("POST", "/api/admin/v1/provider-models/probe", {
    provider: "gemini", apiKey: "E2E_UPSTREAM_KEY", baseUrl: `http://127.0.0.1:${upstreamPort}`
  })).json();
  check("live probe lists models", probed.models.some(m => m.id === "mock-probe"));

  // Group over an explicit key×model target
  check("group created", (await api("POST", "/api/admin/v1/groups", {
    name: "e2e-tier", routingStrategy: "round_robin", fallbackStrategy: "least_used",
    pairs: [{ credentialId: credId, modelId: "gemini-2.0-flash" }]
  })).status === 201);

  // Client key scoped to the group
  const keyRes = await api("POST", "/api/admin/v1/client-keys", {
    label: "e2e-app", allowedGroups: ["e2e-tier"]
  });
  const clientKey = (await keyRes.json()).clientApiKey;
  check("client key issued", typeof clientKey === "string" && clientKey.startsWith("gck_"));

  // Gemini gateway round trip
  const gen = await fetch(`http://127.0.0.1:${GEMINI_PORT}/v1beta/models/gemini-2.0-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": clientKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
  });
  const genBody = await gen.json();
  check("gemini gateway relays success", gen.status === 200 && genBody.candidates[0].content.parts[0].text.includes("hello-from-E2E_UPSTREAM_KEY"));

  // OpenAI gateway round trip
  const chat = await fetch(`http://127.0.0.1:${OPENAI_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${clientKey}` },
    body: JSON.stringify({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hello" }] })
  });
  const chatBody = await chat.json();
  check("openai gateway translates response", chat.status === 200 && chatBody.choices[0].message.content.includes("hello-from"));

  // Metrics, logs, audit trail
  const usage = await (await api("GET", "/api/admin/v1/usage-summary?days=1")).json();
  const flash = usage.models.find(m => m.modelId === "gemini-2.0-flash");
  check("usage summary aggregates tokens", flash && flash.requests >= 2 && flash.promptTokens > 0);

  const logs = await (await api("GET", "/api/admin/v1/logs?limit=5")).json();
  check("request logs recorded", logs.total > 0);

  const audit = await (await api("GET", "/api/admin/v1/audit-logs")).json();
  const actions = audit.logs.map(l => l.action);
  check("audit trail captures setup + mutations", actions.includes("setup") && actions.includes("create"));

  console.log(failures === 0 ? "\ne2e: ALL CHECKS PASSED" : `\ne2e: ${failures} CHECK(S) FAILED`);
} catch (err) {
  failures++;
  console.error("\ne2e crashed:", err);
} finally {
  child.kill("SIGTERM");
  mock?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
}
process.exit(failures === 0 ? 0 : 1);
