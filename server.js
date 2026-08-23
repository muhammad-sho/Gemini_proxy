const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 18765);
const DB_PATH = process.env.DB_PATH || "./local-gemini-proxy.db";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 50 * 1024 * 1024);
const TRANSIENT_COOLDOWN_SECONDS = 60;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const loginFailures = [];
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const SETUP_TOKEN = process.env.SETUP_TOKEN || crypto.randomBytes(32).toString("base64url");

const db = new DatabaseSync(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch {}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_text TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models (
    name TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    key_id INTEGER,
    status INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_key_state (
    model TEXT NOT NULL,
    key_id INTEGER NOT NULL,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    cooldown_reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (model, key_id)
  );
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_requests_model_key_success_time ON requests(model, key_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_requests_model_success_time ON requests(model, status, created_at);
`);

try { db.exec("ALTER TABLE model_key_state ADD COLUMN cooldown_reason TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE client_keys ADD COLUMN key_text TEXT"); } catch {}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("Cache-Control", "no-store");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > MAX_BODY_BYTES) reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function localKeyIsValid(request) {
  const query = new URL(request.url, "http://localhost").searchParams;
  const supplied = request.headers["x-proxy-api-key"] ||
    request.headers["x-goog-api-key"] ||
    query.get("key") || "";
  if (!supplied) return false;
  const hash = hashValue(supplied);
  return Boolean(db.prepare("SELECT id FROM client_keys WHERE key_hash = ? AND enabled = 1").get(hash));
}

function dashboardSessionValid(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.match(/gemini_dashboard=([^;]+)/)?.[1];
  const session = token ? sessions.get(token) : null;
  if (!session) return false;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return false; }
  return true;
}

function sessionFromRequest(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.match(/gemini_dashboard=([^;]+)/)?.[1];
  const session = token ? sessions.get(token) : null;
  return session && session.expiresAt > Date.now() ? session : null;
}

function csrfValid(request) {
  const session = sessionFromRequest(request);
  const cookieToken = (request.headers.cookie || "").match(/(?:^|; )gemini_csrf=([^;]+)/)?.[1] || "";
  const headerToken = request.headers["x-csrf-token"] || "";
  return Boolean(session && cookieToken && headerToken && cookieToken === headerToken && session.csrfToken === headerToken);
}

function clientAddress(request) {
  if (TRUST_PROXY) {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim() || "unknown";
  }
  return request.socket.remoteAddress || "unknown";
}

function pruneLoginAttempts() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [address, attempts] of loginAttempts) {
    const recent = attempts.filter((time) => time > cutoff);
    if (recent.length) loginAttempts.set(address, recent);
    else loginAttempts.delete(address);
  }
  while (loginFailures.length && loginFailures[0] <= cutoff) loginFailures.shift();
}

function rateLimited(address) {
  const now = Date.now();
  const recent = (loginAttempts.get(address) || []).filter((time) => time > now - 15 * 60 * 1000);
  loginAttempts.set(address, recent);
  pruneLoginAttempts();
  return recent.length >= 10 || loginFailures.length >= 1000;
}

function recordLoginFailure(address) {
  const recent = loginAttempts.get(address) || [];
  recent.push(Date.now());
  loginAttempts.set(address, recent);
  loginFailures.push(Date.now());
}

function hasAdmin() {
  return Boolean(db.prepare("SELECT id FROM admin_users LIMIT 1").get());
}

function passwordDigest(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

async function passwordValid(password, user) {
  const actual = Buffer.from(await passwordDigest(password, user.password_salt), "hex");
  const expected = Buffer.from(user.password_hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createClientKey(label = "Default client key") {
  const value = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO client_keys (label,key_hash,key_prefix,key_text,created_at) VALUES (?,?,?,?,?)")
    .run(label, hashValue(value), `${value.slice(0, 8)}...`, value, Date.now());
  return value;
}

const setupPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gemini Proxy Setup</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#f8fafc;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;width:100%;max-width:440px;box-shadow:0 4px 12px rgba(0,0,0,0.05)}.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}.badge{width:32px;height:32px;background:#0f172a;color:#fff;border-radius:6px;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}h1{font-size:20px;font-weight:800;letter-spacing:-0.02em}p{font-size:13px;color:#64748b;margin-bottom:20px;line-height:1.5}label{display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:6px}input{font-family:inherit;font-size:14px;width:100%;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;outline:none;margin-bottom:14px}input:focus{border-color:#0f172a}button{font-family:inherit;font-size:14px;font-weight:700;width:100%;padding:12px;border:none;border-radius:8px;background:#0f172a;color:#fff;cursor:pointer;transition:background .15s}button:hover{background:#334155}a{color:#0f172a;font-weight:700;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="card"><div class="brand"><div class="badge">GP</div><h1>First-Time Setup</h1></div><p>Create the dashboard administrator. Enter the setup token printed in the container logs.</p><form id="setup"><label>Setup Token</label><input name="setupToken" placeholder="Setup token from logs" required><label>Admin Username</label><input name="username" placeholder="Username" required><label>Admin Password</label><input name="password" type="password" minlength="8" placeholder="Password (8+ chars)" required><button>Create Administrator Account</button></form><div id="result"></div></div><script>setup.onsubmit=async e=>{e.preventDefault();let f=new FormData(e.target);let r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupToken:f.get('setupToken'),username:f.get('username'),password:f.get('password')})});let d=await r.json();if(!r.ok)return alert(d.error);result.innerHTML='<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0"><p style="color:#0f172a;font-weight:700;margin-bottom:4px">Administrator account created.</p><p>Sign in to add Gemini keys and generate client API keys.</p><p style="margin-top:12px"><a href="/">Continue to Sign In &rarr;</a></p></div>';e.target.remove()}</script></body></html>`;

function modelNameFromPath(path) {
  const match = path.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function enabledKeys() {
  return db.prepare("SELECT id, api_key FROM api_keys WHERE enabled = 1 ORDER BY id").all();
}

function setMeta(key, value) {
  db.prepare("INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

function getMeta(key) {
  return db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key)?.value || null;
}

function pacificDayStart(now = Date.now()) {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "longOffset",
  }).formatToParts(new Date(now)).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offsetMatch = offsetPart.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offsetMinutes = offsetMatch
    ? (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * (offsetMatch[1] === "+" ? 1 : -1)
    : 0;
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - offsetMinutes * 60_000;
}

function usageStats() {
  const start = pacificDayStart();
  return db.prepare(`
    SELECT m.name AS model, k.id AS key_id, k.label,
           substr(k.api_key, 1, 6) || '...' AS masked,
           COUNT(r.id) AS today, MAX(r.created_at) AS last_request,
           COALESCE(s.cooldown_until, 0) AS cooldown_until,
           COALESCE(s.cooldown_reason, '') AS cooldown_reason
    FROM (SELECT name FROM models UNION SELECT DISTINCT model AS name FROM requests UNION SELECT DISTINCT model AS name FROM model_key_state) m
    CROSS JOIN api_keys k
    LEFT JOIN requests r ON r.model = m.name AND r.key_id = k.id
      AND r.status >= 200 AND r.status < 300 AND r.created_at >= ?
    LEFT JOIN model_key_state s ON s.model = m.name AND s.key_id = k.id
    GROUP BY m.name, k.id, k.label, k.api_key, s.cooldown_until, s.cooldown_reason
    ORDER BY m.name, k.id
  `).all(start).filter((row) => row.today > 0 || row.cooldown_until > Date.now());
}

function recordRequest(model, keyId, status) {
  if (status < 200 || status >= 300) return;
  db.prepare("INSERT INTO requests (model, key_id, status, created_at) VALUES (?, ?, ?, ?)").run(model, keyId, status, Date.now());
  db.prepare("DELETE FROM requests WHERE created_at < ?").run(Date.now() - 86_400_000);
}

function setCooldown(model, keyId, seconds, reason) {
  db.prepare("INSERT INTO model_key_state (model,key_id,cooldown_until,cooldown_reason) VALUES (?,?,?,?) ON CONFLICT(model,key_id) DO UPDATE SET cooldown_until=excluded.cooldown_until,cooldown_reason=excluded.cooldown_reason")
    .run(model, keyId, Date.now() + Math.max(0, seconds) * 1000, reason);
}

function nextPacificReset(now = Date.now()) {
  return pacificDayStart(pacificDayStart(now) + 36 * 60 * 60 * 1000);
}

function keyCooldown(model, keyId) {
  const state = db.prepare("SELECT cooldown_until,cooldown_reason FROM model_key_state WHERE model = ? AND key_id = ?").get(model, keyId);
  return state && state.cooldown_until > Date.now() ? state : null;
}

function forwardToGemini(request, body, key) {
  return new Promise((resolve, reject) => {
    const incomingUrl = new URL(request.url, "http://localhost");
    const upstreamUrl = new URL("https://generativelanguage.googleapis.com");
    upstreamUrl.pathname = incomingUrl.pathname;
    upstreamUrl.search = incomingUrl.search;
    if (upstreamUrl.searchParams.has("key")) upstreamUrl.searchParams.set("key", key);
    const headers = {};
    for (const name of ["content-type", "accept", "user-agent", "accept-encoding", "x-goog-api-client", "x-goog-user-project"]) {
      if (request.headers[name]) headers[name] = request.headers[name];
    }
    headers["content-length"] = body.length;
    headers["x-goog-api-key"] = key;
    const upstreamRequest = https.request({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: request.method,
      timeout: REQUEST_TIMEOUT_MS,
      headers,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else tooLarge = true;
      });
      response.on("end", () => {
        if (tooLarge) return reject(Object.assign(new Error("Gemini response is too large"), { status: 502 }));
        resolve({
        status: response.statusCode || 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
        });
      });
    });
    upstreamRequest.on("timeout", () => upstreamRequest.destroy(new Error("Gemini request timed out")));
    upstreamRequest.on("error", reject);
    upstreamRequest.end(body);
  });
}

function returnUpstream(response, result) {
  const headers = { ...result.headers };
  delete headers["transfer-encoding"];
  delete headers.connection;
  response.writeHead(result.status, headers);
  return response.end(result.body);
}

function classifyUpstream(result) {
  let error = {};
  try { error = JSON.parse(result.body.toString("utf8")).error || {}; } catch {}
  const text = `${error.status || ""} ${error.code || ""} ${error.message || ""}`.toLowerCase();
  if (text.includes("api_key_invalid") || text.includes("invalid api key") || result.status === 401) return "invalid_key";
  if (text.includes("quota_exceeded") || text.includes("daily quota") || text.includes("requests per day") || text.includes("per_day") || text.includes("rpd") || text.includes("current quota") || text.includes("resource_exhausted") || text.includes("quota failure")) return "daily_quota";
  if ([408, 429, 500, 502, 503, 504].includes(result.status)) return "transient";
  return "permanent";
}

function setCooldownUntil(model, keyId, timestamp, reason) {
  db.prepare("INSERT INTO model_key_state (model,key_id,cooldown_until,cooldown_reason) VALUES (?,?,?,?) ON CONFLICT(model,key_id) DO UPDATE SET cooldown_until=excluded.cooldown_until,cooldown_reason=excluded.cooldown_reason")
    .run(model, keyId, timestamp, reason);
}

function syncModelsFromGemini(result) {
  let payload;
  try { payload = JSON.parse(result.body.toString("utf8")); } catch { return false; }
  if (!Array.isArray(payload.models)) return false;
  const names = [...new Set(payload.models
    .map((model) => String(model.name || "").replace(/^models\//, "").trim())
    .filter(Boolean))];
  const insert = db.prepare("INSERT INTO models (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  for (const name of names) insert.run(name);
  if (names.length) {
    const placeholders = names.map(() => "?").join(",");
    db.prepare(`DELETE FROM models WHERE name NOT IN (${placeholders})`).run(...names);
  } else {
    db.exec("DELETE FROM models");
  }
  return true;
}

async function refreshModels(request) {
  setMeta("models_checked_at", Date.now());
  const keys = enabledKeys();
  let lastResult = null;
  for (const key of keys) {
    try {
      const result = await forwardToGemini(request, Buffer.alloc(0), key.api_key);
      lastResult = result;
      if (result.status >= 200 && result.status < 300) {
        let payload;
        try { payload = JSON.parse(result.body.toString("utf8")); } catch { payload = null; }
        if (payload && Array.isArray(payload.models)) {
          const allModels = [...payload.models];
          let pageToken = payload.nextPageToken;
          for (let page = 0; page < 20 && pageToken; page += 1) {
            const pageUrl = new URL(request.url, "http://localhost");
            pageUrl.searchParams.set("pageToken", pageToken);
            const pageResult = await forwardToGemini({ ...request, url: pageUrl.pathname + pageUrl.search }, Buffer.alloc(0), key.api_key);
            if (pageResult.status < 200 || pageResult.status >= 300) break;
            let pagePayload;
            try { pagePayload = JSON.parse(pageResult.body.toString("utf8")); } catch { pagePayload = null; }
            if (!pagePayload || !Array.isArray(pagePayload.models)) break;
            allModels.push(...pagePayload.models);
            pageToken = pagePayload.nextPageToken;
          }
          if (syncModelsFromGemini({ body: Buffer.from(JSON.stringify({ models: allModels })) })) return result;
        }
      }
    } catch (error) {
      console.error(`[Models] key ${key.id}: ${error.message}`);
    }
  }
  return lastResult || { status: 503, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "No enabled Gemini API keys" })) };
}

async function handleGemini(request, response, model) {
  if (!localKeyIsValid(request)) return json(response, 401, { error: "Invalid proxy API key" });

  let body;
  try { body = await readBody(request); } catch (error) { return json(response, error.status || 400, { error: error.message }); }
  const keys = enabledKeys().filter((key) => !keyCooldown(model, key.id));
  if (!keys.length) return json(response, 503, { error: "No enabled Gemini API keys" });

  const usage = db.prepare("SELECT key_id, COUNT(*) AS count FROM requests WHERE model = ? AND status >= 200 AND status < 300 AND created_at >= ? GROUP BY key_id")
    .all(model, pacificDayStart()).reduce((map, row) => map.set(row.key_id, row.count), new Map());
  keys.sort((left, right) => (usage.get(left.id) || 0) - (usage.get(right.id) || 0) || left.id - right.id);
  let lastResult;
  for (const selected of keys) {
    try {
      const result = await forwardToGemini(request, body, selected.api_key);
      lastResult = result;
      recordRequest(model, selected.id, result.status);
      const classification = classifyUpstream(result);
      if (classification === "daily_quota") {
        setCooldownUntil(model, selected.id, nextPacificReset(), "daily_quota");
        continue;
      } else if (classification === "transient" || classification === "invalid_key") {
        setCooldown(model, selected.id, TRANSIENT_COOLDOWN_SECONDS, classification === "invalid_key" ? "invalid_key" : "high_demand");
        continue;
      }
      return returnUpstream(response, result);
    } catch (error) {
      console.error(`[Gemini] key ${selected.id}: ${error.message}`);
      setCooldown(model, selected.id, TRANSIENT_COOLDOWN_SECONDS, "upstream_error");
    }
  }
  if (lastResult) {
    return returnUpstream(response, lastResult);
  }
  return json(response, 502, { error: "All Gemini API keys failed" });
}

const dashboard = fs.readFileSync("dashboard.html", "utf8");

async function handleRequest(request, response) {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/health") return json(response, 200, { ok: true });
  if (url.pathname === "/v1beta/models" && ["GET", "POST"].includes(request.method)) {
    if (!localKeyIsValid(request)) return json(response, 401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid proxy API key" } });
    return returnUpstream(response, await refreshModels(request));
  }
  if (url.pathname === "/" && request.method === "GET") {
    if (!hasAdmin()) { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(setupPage); }
    if (!dashboardSessionValid(request)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gemini Proxy Sign In</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:\'Plus Jakarta Sans\',system-ui,sans-serif;background:#f8fafc;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px;width:100%;max-width:380px;box-shadow:0 4px 12px rgba(0,0,0,0.05)}.brand{display:flex;align-items:center;gap:10px;margin-bottom:8px}.badge{width:32px;height:32px;background:#0f172a;color:#fff;border-radius:6px;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}h1{font-size:20px;font-weight:800;letter-spacing:-0.02em}p{font-size:13px;color:#64748b;margin-bottom:24px}label{display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:6px}input{font-family:inherit;font-size:14px;width:100%;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;outline:none;margin-bottom:14px}input:focus{border-color:#0f172a}button{font-family:inherit;font-size:14px;font-weight:700;width:100%;padding:12px;border:none;border-radius:8px;background:#0f172a;color:#fff;cursor:pointer;margin-top:6px;transition:background .15s}button:hover{background:#334155}</style></head><body><div class="card"><div class="brand"><div class="badge">GP</div><h1>Gemini Proxy</h1></div><p>Sign in to access key routing & usage telemetry</p><form method="post" action="/login"><label>Username</label><input name="username" placeholder="Username" required><label>Password</label><input name="password" type="password" placeholder="Password" required><button>Sign In</button></form></div></body></html>');
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(dashboard);
  }
  if (url.pathname === "/api/setup" && request.method === "POST") {
    if (hasAdmin()) return json(response, 409, { error: "Setup is already complete" });
    if (rateLimited(clientAddress(request))) return json(response, 429, { error: "Too many setup attempts" });
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    if (body.setupToken !== SETUP_TOKEN) { recordLoginFailure(clientAddress(request)); return json(response, 403, { error: "Invalid setup token" }); }
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(String(body.username || ""))) return json(response, 400, { error: "Username must be 3-64 letters, numbers, _, ., or -" });
    if (String(body.password || "").length < 8) return json(response, 400, { error: "Password must be at least 8 characters" });
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await passwordDigest(String(body.password), salt);
    try {
      db.exec("BEGIN IMMEDIATE");
      if (hasAdmin()) { db.exec("ROLLBACK"); return json(response, 409, { error: "Setup is already complete" }); }
      db.prepare("INSERT INTO admin_users (username,password_hash,password_salt,created_at) VALUES (?,?,?,?)").run(String(body.username), passwordHash, salt, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (String(error.code || "").includes("CONSTRAINT")) return json(response, 409, { error: "Setup is already complete" });
      throw error;
    }
    return json(response, 201, { ok: true });
  }
  if (url.pathname === "/login" && request.method === "POST") {
    const address = clientAddress(request);
    if (rateLimited(address)) return json(response, 429, { error: "Too many login attempts; try again later" });
    let raw; try { raw = (await readBody(request)).toString(); } catch { return json(response, 400, { error: "Invalid request" }); }
    const body = Object.fromEntries(new URLSearchParams(raw));
    const fallbackUser = db.prepare("SELECT username FROM admin_users ORDER BY id LIMIT 1").get();
    const username = body.username || fallbackUser?.username;
    const user = username ? db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username) : null;
    if (!user || !(await passwordValid(String(body.password || ""), user))) { recordLoginFailure(address); return json(response, 401, { error: "Invalid username or password" }); }
    loginAttempts.delete(address);
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, csrfToken });
    const secure = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted ? "; Secure" : "";
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": [`gemini_dashboard=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`, `gemini_csrf=${csrfToken}; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`] }); return response.end();
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    if (!csrfValid(request)) return json(response, 403, { error: "Invalid CSRF token" });
    const token = (request.headers.cookie || "").match(/(?:^|; )gemini_dashboard=([^;]+)/)?.[1];
    if (token) sessions.delete(token);
    response.writeHead(303, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": ["gemini_dashboard=; HttpOnly; SameSite=Strict; Max-Age=0", "gemini_csrf=; SameSite=Strict; Max-Age=0"] });
    return response.end();
  }
  if (url.pathname.startsWith("/api/admin") && !dashboardSessionValid(request)) return json(response, 401, { error: "Dashboard login required" });
  if (url.pathname.startsWith("/api/admin") && request.method !== "GET" && !csrfValid(request)) return json(response, 403, { error: "Invalid CSRF token" });
  if (url.pathname === "/api/admin/state" && request.method === "GET") {
    const keys = db.prepare("SELECT id,label,enabled,substr(api_key,1,6)||'...' AS masked FROM api_keys ORDER BY id").all();
    const clientKeys = db.prepare("SELECT id,label,enabled,key_prefix AS masked,key_text AS value FROM client_keys ORDER BY id").all();
    return json(response, 200, { keys, clientKeys, usage: usageStats(), resetAt: new Date(pacificDayStart()).toISOString(), resetTimezone: "America/Los_Angeles", modelsCheckedAt: getMeta("models_checked_at") });
  }
  if (url.pathname === "/api/admin/client-keys" && request.method === "POST") {
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    const clientApiKey = createClientKey(String(body.label || "Client key"));
    return json(response, 201, { ok: true, clientApiKey });
  }
  const clientKeyMatch = url.pathname.match(/^\/api\/admin\/client-keys\/(\d+)$/);
  if (clientKeyMatch && request.method === "PATCH") { let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); } db.prepare("UPDATE client_keys SET enabled=? WHERE id=?").run(body.enabled ? 1 : 0, Number(clientKeyMatch[1])); return json(response, 200, { ok: true }); }
  if (clientKeyMatch && request.method === "DELETE") { db.prepare("DELETE FROM client_keys WHERE id=?").run(Number(clientKeyMatch[1])); return json(response, 200, { ok: true }); }
  if (url.pathname === "/api/admin/keys" && request.method === "POST") {
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    if (!body.label || !body.key) return json(response, 400, { error: "Label and key are required" });
    db.prepare("INSERT INTO api_keys (label,api_key,created_at) VALUES (?,?,?)").run(String(body.label), String(body.key), Date.now()); return json(response, 201, { ok: true });
  }
  const keyMatch = url.pathname.match(/^\/api\/admin\/keys\/(\d+)$/);
  if (keyMatch && request.method === "PATCH") { let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); } db.prepare("UPDATE api_keys SET enabled=? WHERE id=?").run(body.enabled ? 1 : 0, Number(keyMatch[1])); return json(response, 200, { ok: true }); }
  if (keyMatch && request.method === "DELETE") {
    const keyId = Number(keyMatch[1]);
    db.prepare("DELETE FROM requests WHERE key_id=?").run(keyId);
    db.prepare("DELETE FROM model_key_state WHERE key_id=?").run(keyId);
    db.prepare("DELETE FROM api_keys WHERE id=?").run(keyId);
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST") { const model = modelNameFromPath(url.pathname); if (model) return handleGemini(request, response, model); }
  return json(response, 404, { error: "Not found" });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(`[HTTP] ${error.stack || error.message}`);
    if (!response.headersSent) json(response, error.status || 500, { error: "Internal server error" });
    else response.destroy();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini proxy listening on port ${PORT}`);
  if (!hasAdmin()) console.log(`[Setup] One-time setup token: ${SETUP_TOKEN}`);
});
