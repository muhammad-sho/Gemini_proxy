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
const KEY_FALLBACK_ATTEMPTS = Math.max(1, Number(process.env.KEY_FALLBACK_ATTEMPTS || 2));
const KEY_LOOP_DEADLINE_MS = Number(process.env.KEY_LOOP_DEADLINE_MS || 0) || REQUEST_TIMEOUT_MS;
const MODELS_CACHE_TTL_MS = Number(process.env.MODELS_CACHE_TTL_HOURS || 24) * 60 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const loginFailures = [];
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const SETUP_TOKEN = process.env.SETUP_TOKEN || crypto.randomBytes(32).toString("base64url");

function log(level, category, message) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${category}] ${message}`;
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}
const dbg = (category, message) => log("debug", category, message);
const maskKey = (key) => `${String(key || "").slice(0, 6)}...`;

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
  CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
`);

try { db.exec("ALTER TABLE model_key_state ADD COLUMN cooldown_reason TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE client_keys ADD COLUMN key_text TEXT"); } catch {}

function json(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
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
    let failed = false;
    request.on("data", (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        request.destroy();
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    request.on("error", (error) => { if (!failed) { failed = true; reject(error); } });
  });
}

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left, right) {
  return crypto.timingSafeEqual(Buffer.from(hashValue(String(left)), "hex"), Buffer.from(hashValue(String(right)), "hex"));
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
  const token = (request.headers.cookie || "").match(/(?:^|; )gemini_dashboard=([^;]+)/)?.[1];
  const session = token ? sessions.get(token) : null;
  if (!session) return false;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return false; }
  return true;
}

function sessionFromRequest(request) {
  const token = (request.headers.cookie || "").match(/(?:^|; )gemini_dashboard=([^;]+)/)?.[1];
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
    if (forwarded) return String(forwarded).split(",").pop().trim() || "unknown";
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

let globalCapLoggedAt = 0;
function rateLimited(address) {
  const now = Date.now();
  const recent = (loginAttempts.get(address) || []).filter((time) => time > now - 15 * 60 * 1000);
  loginAttempts.set(address, recent);
  pruneLoginAttempts();
  if (recent.length >= 10) return true;
  if (loginFailures.length >= 1000) {
    if (now - globalCapLoggedAt > 60_000) {
      globalCapLoggedAt = now;
      log("warn", "Auth", `global failure cap reached (${loginFailures.length} failures in window); rejecting logins from all addresses`);
    }
    return true;
  }
  return false;
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
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
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
    CROSS JOIN (SELECT id, label, api_key FROM api_keys WHERE enabled = 1) k
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
}

let lastSweptUsageDay = null;
function sweepDailyReset() {
  const today = pacificDayStart();
  if (lastSweptUsageDay !== null && today !== lastSweptUsageDay) {
    log("info", "Usage", "Pacific midnight reset - cleared previous day's usage and expired cooldowns");
  }
  lastSweptUsageDay = today;
  const purgedRequests = db.prepare("DELETE FROM requests WHERE created_at < ?").run(today).changes;
  const purgedCooldowns = db.prepare("DELETE FROM model_key_state WHERE cooldown_until <= ?").run(Date.now()).changes;
  if (purgedRequests || purgedCooldowns) dbg("Usage", `sweep removed ${purgedRequests} old request row(s), ${purgedCooldowns} expired cooldown(s)`);
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

function forwardToGemini(request, body, key, opts = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const incomingUrl = new URL(request.url, "http://localhost");
    const upstreamUrl = new URL("https://generativelanguage.googleapis.com");
    upstreamUrl.pathname = incomingUrl.pathname;
    upstreamUrl.search = incomingUrl.search;
    if (upstreamUrl.searchParams.has("key")) upstreamUrl.searchParams.set("key", key);
    const headers = {};
    for (const name of ["content-type", "accept", "user-agent", "x-goog-api-client", "x-goog-user-project"]) {
      if (request.headers[name]) headers[name] = request.headers[name];
    }
    headers["content-length"] = body.length;
    headers["x-goog-api-key"] = key;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const clientResponse = opts.clientResponse;
    const upstreamRequest = https.request({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: request.method,
      timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Number(opts.timeoutMs) || REQUEST_TIMEOUT_MS)),
      headers,
    }, (response) => {
      dbg("Upstream", `key ${maskKey(key)} -> ${request.method} ${upstreamUrl.pathname}${upstreamUrl.search} started (timeout ${Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Number(opts.timeoutMs) || REQUEST_TIMEOUT_MS))}ms)`);
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else tooLarge = true;
      });
      response.on("end", () => {
        if (tooLarge) return finish(reject, Object.assign(new Error("Gemini response is too large"), { status: 502 }));
        dbg("Upstream", `key ${maskKey(key)} <- ${response.statusCode} (${Date.now() - startedAt}ms, ${Buffer.concat(chunks).length} bytes)`);
        finish(resolve, {
          status: response.statusCode || 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    if (clientResponse) {
      clientResponse.on("close", () => {
        if (!clientResponse.writableEnded && !settled) upstreamRequest.destroy(new Error("Client disconnected"));
      });
    }
    upstreamRequest.on("timeout", () => upstreamRequest.destroy(new Error("Gemini request timed out")));
    upstreamRequest.on("error", (error) => finish(reject, error));
    upstreamRequest.end(body);
  });
}

function returnUpstream(response, result) {
  if (response.writableEnded || response.destroyed) return;
  const headers = {};
  for (const name of ["content-type", "content-length", "retry-after"]) {
    if (result.headers[name]) headers[name] = result.headers[name];
  }
  response.writeHead(result.status, headers);
  return response.end(result.body);
}

function classifyUpstream(result) {
  let error = {};
  try { error = JSON.parse(result.body.toString("utf8")).error || {}; } catch {}
  const message = `${error.status || ""} ${error.code || ""} ${error.message || ""}`.toLowerCase();
  if (message.includes("api_key_invalid") || message.includes("invalid api key") || result.status === 401) return "invalid_key";
  const detailsText = JSON.stringify(error.details || []).toLowerCase();
  if (/\b(per[_ ]?day|daily|requests per day|\brpd\b)\b/.test(message) || detailsText.includes("perday") || detailsText.includes("per_day")) return "daily_quota";
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
  if (!names.length) return false;
  const insert = db.prepare("INSERT INTO models (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  for (const name of names) insert.run(name);
  const placeholders = names.map(() => "?").join(",");
  db.prepare(`DELETE FROM models WHERE name NOT IN (${placeholders})`).run(...names);
  return true;
}

function buildModelsPayload(allModels) {
  const seen = new Set();
  const models = [];
  for (const model of allModels) {
    const name = String(model?.name || "").replace(/^models\//, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push({ ...model, name });
  }
  models.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { models };
}

let modelsRefreshInFlight = null;
function refreshModelsOnce(request) {
  if (!modelsRefreshInFlight) {
    modelsRefreshInFlight = refreshModels(request).finally(() => { modelsRefreshInFlight = null; });
  }
  return modelsRefreshInFlight;
}

async function refreshModels(request) {
  const keys = enabledKeys();
  log("info", "Models", `sync started: racing ${keys.length} enabled key(s)`);
  const attempts = keys.map((key) => (async () => {
    const result = await forwardToGemini(request, Buffer.alloc(0), key.api_key);
    if (result.status < 200 || result.status >= 300) {
      log("warn", "Models", `key ${maskKey(key.api_key)} returned ${result.status}; skipping`);
      return { key, result, models: null };
    }
    let payload;
    try { payload = JSON.parse(result.body.toString("utf8")); } catch { payload = null; }
    if (!payload || !Array.isArray(payload.models)) {
      log("error", "Models", `key ${maskKey(key.api_key)}: 200 but body is not a models list (first bytes: ${result.body.subarray(0, 40).toString("hex")})`);
      return { key, result, models: null };
    }
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
    return { key, result, models: buildModelsPayload(allModels) };
  })());
  const settled = await Promise.allSettled(attempts);
  let lastResult = null;
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") {
      log("error", "Models", `key attempt threw: ${outcome.reason?.message}`);
      continue;
    }
    const { key, result, models } = outcome.value;
    lastResult = lastResult || result;
    if (models && models.models.length) {
      setMeta("models_cache", JSON.stringify(models));
      setMeta("models_checked_at", Date.now());
      syncModelsFromGemini({ body: Buffer.from(JSON.stringify(models)) });
      log("info", "Models", `sync succeeded via key ${maskKey(key.api_key)}: ${models.models.length} models cached`);
      return result;
    }
  }
  log("error", "Models", `sync failed on all ${keys.length} key(s)`);
  return lastResult || { status: 503, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "No enabled Gemini API keys" })) };
}

function syntheticModelsRequest() {
  return { url: "/v1beta/models?pageSize=1000", method: "GET", headers: {} };
}

async function handleModelsList(request, response) {
  let cached = null;
  try { cached = JSON.parse(getMeta("models_cache") || "null"); } catch {}
  const checkedAt = Number(getMeta("models_checked_at") || 0);
  if (cached && Array.isArray(cached.models) && cached.models.length) {
    if (Date.now() - checkedAt >= MODELS_CACHE_TTL_MS) {
      log("info", "Models", `cache stale (age ${Math.round((Date.now() - checkedAt) / 60000)}min > TTL); serving cached list and refreshing in background`);
      refreshModelsOnce(syntheticModelsRequest()).catch((error) => log("error", "Models", `background refresh failed: ${error.message}`));
    } else {
      dbg("Models", `cache hit (${cached.models.length} models, age ${Math.round((Date.now() - checkedAt) / 60000)}min)`);
    }
    return json(response, 200, cached);
  }
  // Fallback: cache missing but models table has data — rebuild from DB and
  // serve instantly while a real refresh runs in the background.
  const dbModels = db.prepare("SELECT name FROM models ORDER BY name").all();
  if (dbModels.length) {
    log("info", "Models", `cache empty but ${dbModels.length} known models in database; serving DB fallback and refreshing in background`);
    const payload = { models: dbModels.map(m => ({ name: m.name })) };
    setMeta("models_cache", JSON.stringify(payload));
    setMeta("models_checked_at", Date.now());
    refreshModelsOnce(syntheticModelsRequest()).catch((error) => log("error", "Models", `background refresh failed: ${error.message}`));
    return json(response, 200, payload);
  }
  log("info", "Models", `no cache and no known models; blocking on upstream sync`);
  return returnUpstream(response, await refreshModelsOnce(request));
}

async function handleGemini(request, response, model) {
  if (!localKeyIsValid(request)) {
    log("warn", "Auth", `rejected ${request.method} ${request.url}: invalid client key from ${clientAddress(request)}`);
    return json(response, 401, { error: "Invalid proxy API key" });
  }

  let body;
  try { body = await readBody(request); } catch (error) { return json(response, error.status || 400, { error: error.message }); }
  const allKeys = enabledKeys();
  const cooledCount = allKeys.length ? allKeys.filter((key) => keyCooldown(model, key.id)).length : 0;
  const keys = allKeys.filter((key) => !keyCooldown(model, key.id));
  if (!keys.length) {
    const soonest = db.prepare("SELECT MIN(cooldown_until) AS until FROM model_key_state WHERE model = ? AND cooldown_until > ?").get(model, Date.now())?.until || 0;
    const retryAfterSeconds = soonest ? Math.max(1, Math.ceil((soonest - Date.now()) / 1000)) : null;
    log("warn", "Gemini", `${model}: request rejected, no available keys (${allKeys.length} enabled, ${cooledCount} cooling down${retryAfterSeconds ? `, next free in ~${retryAfterSeconds}s` : ""})`);
    return json(response, 503, { error: { code: 503, status: "UNAVAILABLE", message: "All enabled Gemini API keys are cooling down or disabled for this model" }, retryAfterSeconds });
  }
  dbg("Gemini", `${model}: ${keys.length} candidate key(s), ${cooledCount} skipped for cooldown`);

  const usage = db.prepare("SELECT key_id, COUNT(*) AS count FROM requests WHERE model = ? AND status >= 200 AND status < 300 AND created_at >= ? GROUP BY key_id")
    .all(model, pacificDayStart()).reduce((map, row) => map.set(row.key_id, row.count), new Map());
  keys.sort((left, right) => (usage.get(left.id) || 0) - (usage.get(right.id) || 0) || left.id - right.id);
  dbg("Gemini", `${model}: rotation order ${keys.map((key) => `#${key.id}(${maskKey(key.api_key)}, used ${usage.get(key.id) || 0})`).join(" -> ")}`);
  let lastResult;
  let attempt = 0;
  const loopStartedAt = Date.now();
  for (const selected of keys) {
    if (attempt >= KEY_FALLBACK_ATTEMPTS) {
      log("info", "Gemini", `${model}: reached attempt cap (${KEY_FALLBACK_ATTEMPTS}); relaying last upstream response to client`);
      break;
    }
    if (response.writableEnded || response.destroyed) return;
    attempt += 1;
    const elapsed = Date.now() - loopStartedAt;
    if (elapsed >= KEY_LOOP_DEADLINE_MS) {
      log("warn", "Gemini", `${model}: key loop budget ${KEY_LOOP_DEADLINE_MS}ms exhausted after ${attempt - 1} attempt(s); stopping`);
      break;
    }
    log("info", "Gemini", `${model}: attempt ${attempt}/${Math.min(keys.length, KEY_FALLBACK_ATTEMPTS)} using key #${selected.id} ${maskKey(selected.api_key)}`);
    try {
      const result = await forwardToGemini(request, body, selected.api_key, { timeoutMs: KEY_LOOP_DEADLINE_MS - elapsed, clientResponse: response });
      lastResult = result;
      recordRequest(model, selected.id, result.status);
      const classification = classifyUpstream(result);
      if (classification === "daily_quota") {
        setCooldownUntil(model, selected.id, nextPacificReset(), "daily_quota");
        log("warn", "Gemini", `key #${selected.id} hit daily quota on ${model}; cooldown until Pacific midnight`);
        continue;
      } else if (classification === "transient" || classification === "invalid_key") {
        setCooldown(model, selected.id, TRANSIENT_COOLDOWN_SECONDS, classification === "invalid_key" ? "invalid_key" : "high_demand");
        log("warn", "Gemini", `key #${selected.id} got ${result.status} (${classification}) on ${model}; cooldown ${TRANSIENT_COOLDOWN_SECONDS}s`);
        continue;
      }
      dbg("Gemini", `${model}: key #${selected.id} succeeded with ${result.status}; returning upstream response to client`);
      return returnUpstream(response, result);
    } catch (error) {
      log("warn", "Gemini", `key #${selected.id} transport failure on ${model}: ${error.message}`);
      setCooldown(model, selected.id, TRANSIENT_COOLDOWN_SECONDS, "upstream_error");
      if (response.writableEnded || response.destroyed) return;
    }
  }
  if (lastResult) {
    log("info", "Gemini", `${model}: relaying Google's response as-is after ${attempt} attempt(s): status ${lastResult.status}`);
    return returnUpstream(response, lastResult);
  }
  log("error", "Gemini", `${model}: ${attempt} attempt(s) failed without any upstream response`);
  return json(response, 502, { error: { code: 502, status: "BAD_GATEWAY", message: "Gemini did not respond on any attempted key" } });
}

const dashboard = fs.readFileSync("dashboard.html", "utf8");

async function handleRequest(request, response) {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (Number(request.headers["content-length"] || 0) > MAX_BODY_BYTES) {
    json(response, 413, { error: "Request body is too large" });
    request.resume();
    return;
  }
  if (url.pathname === "/health") return json(response, 200, { ok: true });
  if (url.pathname === "/v1beta/models" && ["GET", "POST"].includes(request.method)) {
    if (!localKeyIsValid(request)) {
      log("warn", "Auth", `rejected ${request.method} /v1beta/models: invalid client key from ${clientAddress(request)}`);
      return json(response, 401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid proxy API key" } });
    }
    return handleModelsList(request, response);
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
    if (!constantTimeEqual(body.setupToken || "", SETUP_TOKEN)) {
      log("warn", "Auth", `invalid setup token from ${clientAddress(request)}`);
      recordLoginFailure(clientAddress(request));
      return json(response, 403, { error: "Invalid setup token" });
    }
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
    if (rateLimited(address)) {
      log("warn", "Auth", `login rate-limited from ${address}`);
      return json(response, 429, { error: "Too many login attempts; try again later" });
    }
    let raw; try { raw = (await readBody(request)).toString(); } catch { return json(response, 400, { error: "Invalid request" }); }
    const body = Object.fromEntries(new URLSearchParams(raw));
    const username = String(body.username || "");
    const user = username ? db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username) : null;
    if (!user || !(await passwordValid(String(body.password || ""), user))) {
      log("warn", "Auth", `failed login for username '${username || "(empty)"}' from ${address}`);
      recordLoginFailure(address);
      return json(response, 401, { error: "Invalid username or password" });
    }
    loginAttempts.delete(address);
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, csrfToken });
    log("info", "Auth", `user '${username}' logged in from ${address} (session expires in ${SESSION_TTL_MS / 3600000}h)`);
    const secure = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted ? "; Secure" : "";
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": [`gemini_dashboard=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`, `gemini_csrf=${csrfToken}; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`] }); return response.end();
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    if (!csrfValid(request)) return json(response, 403, { error: "Invalid CSRF token" });
    const token = (request.headers.cookie || "").match(/(?:^|; )gemini_dashboard=([^;]+)/)?.[1];
    if (token) sessions.delete(token);
    log("info", "Auth", `user logged out`);
    response.writeHead(303, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": ["gemini_dashboard=; HttpOnly; SameSite=Strict; Max-Age=0", "gemini_csrf=; SameSite=Strict; Max-Age=0"] });
    return response.end();
  }
  if (url.pathname.startsWith("/api/admin") && !dashboardSessionValid(request)) {
    if (!url.pathname.startsWith("/api/admin/state")) log("warn", "Auth", `rejected ${request.method} ${url.pathname}: no valid dashboard session`);
    return json(response, 401, { error: "Dashboard login required" });
  }
  if (url.pathname.startsWith("/api/admin") && request.method !== "GET" && !csrfValid(request)) {
    log("warn", "Auth", `rejected ${request.method} ${url.pathname}: invalid CSRF token`);
    return json(response, 403, { error: "Invalid CSRF token" });
  }
  if (url.pathname === "/api/admin/state" && request.method === "GET") {
    const keys = db.prepare("SELECT id,label,enabled,substr(api_key,1,6)||'...' AS masked FROM api_keys ORDER BY id").all();
    const clientKeys = db.prepare("SELECT id,label,enabled,key_prefix AS masked,key_text AS value FROM client_keys ORDER BY id").all();
    const models = db.prepare("SELECT name FROM models ORDER BY name").all();
    const cooldowns = db.prepare("SELECT s.model, s.key_id AS keyId, k.label, substr(k.api_key,1,6)||'...' AS masked, s.cooldown_until AS until, s.cooldown_reason AS reason FROM model_key_state s JOIN api_keys k ON k.id = s.key_id WHERE s.cooldown_until > ? ORDER BY s.cooldown_until").all(Date.now());
    return json(response, 200, { keys, clientKeys, usage: usageStats(), resetAt: new Date(pacificDayStart()).toISOString(), resetTimezone: "America/Los_Angeles", modelsCheckedAt: getMeta("models_checked_at"), models, cooldowns });
  }
  if (url.pathname === "/api/admin/cooldowns/clear" && request.method === "POST") {
    const cleared = db.prepare("DELETE FROM model_key_state").run().changes;
    log("info", "Admin", `cleared all model/key cooldowns (${cleared} row(s))`);
    return json(response, 200, { ok: true, cleared });
  }
  if (url.pathname === "/api/admin/models/refresh" && request.method === "POST") {
    log("info", "Admin", `manual model refresh requested`);
    const result = await refreshModelsOnce(syntheticModelsRequest());
    const ok = result.status >= 200 && result.status < 300;
    return json(response, ok ? 200 : 502, { ok, status: result.status });
  }
  if (url.pathname === "/api/admin/client-keys" && request.method === "POST") {
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    const clientApiKey = createClientKey(String(body.label || "Client key"));
    log("info", "Admin", `client key created: '${String(body.label || "Client key")}' ${maskKey(clientApiKey)}`);
    return json(response, 201, { ok: true, clientApiKey });
  }
  const clientKeyMatch = url.pathname.match(/^\/api\/admin\/client-keys\/(\d+)$/);
  if (clientKeyMatch && request.method === "PATCH") { let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); } db.prepare("UPDATE client_keys SET enabled=? WHERE id=?").run(body.enabled ? 1 : 0, Number(clientKeyMatch[1])); log("info", "Admin", `client key #${clientKeyMatch[1]} ${body.enabled ? "enabled" : "disabled"}`); return json(response, 200, { ok: true }); }
  if (clientKeyMatch && request.method === "DELETE") { db.prepare("DELETE FROM client_keys WHERE id=?").run(Number(clientKeyMatch[1])); log("info", "Admin", `client key #${clientKeyMatch[1]} deleted`); return json(response, 200, { ok: true }); }
  if (url.pathname === "/api/admin/keys" && request.method === "POST") {
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    if (!body.label || !body.key) return json(response, 400, { error: "Label and key are required" });
    db.prepare("INSERT INTO api_keys (label,api_key,created_at) VALUES (?,?,?)").run(String(body.label), String(body.key), Date.now());
    log("info", "Admin", `Gemini key added: '${String(body.label)}' ${maskKey(String(body.key))}`);
    return json(response, 201, { ok: true });
  }
  const keyMatch = url.pathname.match(/^\/api\/admin\/keys\/(\d+)$/);
  if (keyMatch && request.method === "PATCH") { let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); } db.prepare("UPDATE api_keys SET enabled=? WHERE id=?").run(body.enabled ? 1 : 0, Number(keyMatch[1])); log("info", "Admin", `Gemini key #${keyMatch[1]} ${body.enabled ? "enabled" : "disabled"}`); return json(response, 200, { ok: true }); }
  if (keyMatch && request.method === "DELETE") {
    const keyId = Number(keyMatch[1]);
    const deleted = db.prepare("SELECT label FROM api_keys WHERE id=?").get(keyId);
    db.prepare("DELETE FROM requests WHERE key_id=?").run(keyId);
    db.prepare("DELETE FROM model_key_state WHERE key_id=?").run(keyId);
    db.prepare("DELETE FROM api_keys WHERE id=?").run(keyId);
    log("info", "Admin", `Gemini key #${keyId}${deleted ? ` ('${deleted.label}')` : ""} deleted with its usage data`);
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST") { const model = modelNameFromPath(url.pathname); if (model) return handleGemini(request, response, model); }
  dbg("HTTP", `no route matched: ${request.method} ${url.pathname}`);
  return json(response, 404, { error: "Not found" });
}

const server = http.createServer((request, response) => {
  response.on("error", () => {});
  const startedAt = Date.now();
  const peer = clientAddress(request);
  response.on("finish", () => {
    log("info", "HTTP", `${request.method} ${request.url} -> ${response.statusCode} (${Date.now() - startedAt}ms) from ${peer}`);
  });
  response.on("close", () => {
    if (!response.writableEnded) log("warn", "HTTP", `${request.method} ${request.url} ABORTED by client after ${Date.now() - startedAt}ms from ${peer}`);
  });
  handleRequest(request, response).catch((error) => {
    log("error", "HTTP", `handler failed for ${request.method} ${request.url}: ${error.stack || error.message}`);
    if (!response.headersSent) json(response, error.status || 500, { error: "Internal server error" });
    else response.destroy();
  });
});

function shutdown(signal) {
  log("info", "Shutdown", `${signal} received; closing server`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

setInterval(() => {
  try {
    sweepDailyReset();
    const now = Date.now();
    let expired = 0;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) { sessions.delete(token); expired += 1; }
    }
    if (expired) dbg("Auth", `pruned ${expired} expired session(s)`);
  } catch (error) { log("error", "Usage", `sweep failed: ${error.message}`); }
}, 60_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  log("info", "Boot", `Gemini proxy listening on port ${PORT} (full debug logging enabled)`);
  if (!hasAdmin()) log("info", "Setup", `one-time setup token: ${SETUP_TOKEN}`);
});

sweepDailyReset();
