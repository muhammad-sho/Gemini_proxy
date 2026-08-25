# Gemini Proxy

A self-hosted Gemini API proxy that pools multiple Google Gemini API keys behind one stable endpoint. It picks the best available key for every request, handles rate limits and cooldowns automatically, and speaks the standard Gemini API — so any app that can call Gemini can use it without changes.

## Features

* Multiple Gemini API keys pooled behind one proxy endpoint
* **Two protocol gateways on separate ports** — native Gemini (`/v1beta/*`) and OpenAI-compatible (`/v1/chat/completions`); each surface always expects its own wire format, no sniffing or guesswork
* **Best-key selection** — ready keys first (least-used rotation per model); if none are ready, cooled keys are still tried as last resort, soonest-expiring cooldown first
* Automatic retry on another key when one fails (`KEY_FALLBACK_ATTEMPTS`)
* Automatic cooldown when a key hits rate limits, transient errors, or daily quota
* Upstream responses relayed verbatim (Gemini gateway) or translated faithfully into OpenAI shape (OpenAI gateway)
* Per-key and per-model usage tracking in a web dashboard
* Model discovery from Google, served from a local cache so `/v1beta/models` and `/v1/models` answer instantly
* Web dashboard: overview stats, client keys, provider credentials, model cache, request logs with timeline and payload inspection
* **Isolated surfaces**: dashboard/admin can run localhost-only while only the gateway ports are exposed publicly
* SQLite storage — no external database needed
* Provider credentials encrypted at rest (AES-256-GCM)
* Docker and Docker Compose support, non-root container with healthcheck
* Client authentication with your own proxy API keys

---

## Architecture

The server is a modular TypeScript/Fastify application. One process hosts **three independent HTTP servers**, each with its own port and purpose:

| Surface | Default bind | Port | Speaks |
| --- | --- | --- | --- |
| **Gemini gateway** | `0.0.0.0` | `18770` | Gemini protocol only (`/v1beta/*`) |
| **OpenAI gateway** | `0.0.0.0` | `18771` | OpenAI protocol only (`/v1/chat/completions`, `/v1/models`) |
| **Dashboard + admin API** | `127.0.0.1` (local) | `18765` | Web UI under `/`, admin JSON under `/api/admin/v1/*`, health checks |

Because each surface always knows which wire format it is receiving, there is no format detection: the Gemini gateway forwards Gemini bodies (translating per provider adapter), while the OpenAI gateway translates chat-completion requests into the canonical internal shape before routing.

Request flow: route → auth → validation → use case → router/adapters → repositories.

```text
src/
├── main.ts                  bootstrap, three listeners, graceful shutdown
├── config/env.ts            Zod-validated environment configuration
├── shared/                  types, crypto (AES-GCM, hashing), time helpers
├── infrastructure/
│   ├── db/                  SQLite connection, versioned migrations, repositories
│   ├── logging/             pino logger with secret masking
│   └── providers/           gemini + openai-compatible upstream adapters
├── domain/
│   ├── auth/                admin sessions
│   ├── providers/           adapter interface + error classification
│   └── routing/             cooldown policies + key selection ordering
├── application/gateway/     routing service (retries/deadline/logging), model cache,
│                            OpenAI ⇄ canonical translation
└── http/
    ├── server.ts            composition root building the three servers
    └── routes/              health, gemini gateway, openai gateway, auth, admin
web/                         React 19 + Vite dashboard (built to dist-web/)
```

Gemini-gateway responses are relayed verbatim; the proxy never rewrites bodies there.
Every attempt is logged with a trace id, timeline events, classification,
latency, and truncated/masked payloads.

---

# Quick Start (Docker Compose)

You only need Docker installed.

```bash
mkdir gemini-proxy && cd gemini-proxy
curl -fsSL -O https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/.env.example
# edit .env: set SETUP_TOKEN and APP_ENCRYPTION_KEY (openssl rand -base64 32);
# every other value has a sane default
docker compose up -d
```

* `SETUP_TOKEN` — the admin password used to log into the dashboard (required).
* `APP_ENCRYPTION_KEY` — encrypts the Google API keys you add later (required in production).

All other settings — ports, routing behavior, cache, limits — live in `.env` too; the compose file only wires volumes and port publishing. Prefer no file at all? `SETUP_TOKEN=... APP_ENCRYPTION_KEY=... docker compose up -d` works as well.

Check `docker compose logs -f`, then open the dashboard at `http://localhost:18765` (the compose file binds it to loopback on the host — reach it via SSH tunnel from elsewhere, e.g. `ssh -L 18765:127.0.0.1:18765 your-server`).

First-time setup:

1. Sign in with `SETUP_TOKEN`.
2. Open **Providers** and add your Google Gemini API keys.
3. Open **Client Keys** and generate a key for your application (shown once).
4. Optionally hit **Refresh cache** under **Models**.

### Run from source (development)

Requires Node.js 22+.

```bash
git clone https://github.com/muhammad-sho/Gemini_proxy.git
cd Gemini_proxy
npm install --legacy-peer-deps
npm run dev          # tsx watch on src/
```

Production-style local run:

```bash
npm run build        # tsc -> dist/, vite -> dist-web/
SETUP_TOKEN=secret APP_ENCRYPTION_KEY=$(openssl rand -base64 32) npm start
```

Useful scripts: `npm run check` (typecheck server+web, lint, tests, dashboard build), `npm test` (Vitest), `npm run web:dev` (dashboard HMR against a running server).

---

# Dashboard

Sign in at `http://localhost:18765` (or wherever `ADMIN_HOST:ADMIN_PORT` points; see "Ports and Exposure"). Tabs:

| Tab | What it does |
| --- | --- |
| **Overview** | Totals (client keys, providers, models, requests today), active cooldowns, usage per model/key, refresh-models and clear-cooldowns actions |
| **Client keys** | Generate/revoke the API keys your applications use; restrict by model or group |
| **Providers** | Add/remove Google Gemini (or OpenAI-compatible) credentials; optional per-credential base URL and model allowlist |
| **Models** | Cached model list from Google with manual refresh |
| **Logs** | Every request with outcome/status/attempt filters and body search; click a row for the full timeline and payloads |

---

# API Usage

Both gateways serve the same credential pool; pick whichever protocol your app already speaks and swap the URL and key. Streaming (`streamGenerateContent` / `"stream": true`) and `countTokens` are not proxied.

## Gemini-protocol gateway (`:18770`)

Endpoints: `GET /v1beta/models` and `POST /v1beta/models/{model}:generateContent`.

The client key can be sent as `x-goog-api-key`, `Authorization: Bearer <key>`, or `?key=`:

```bash
curl http://GATEWAY_HOST:18770/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: YOUR-CLIENT-KEY" \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

The response is Google's response, unchanged — including errors after all retries fail.

## OpenAI-protocol gateway (`:18771`)

Endpoints: `GET /v1/models` and `POST /v1/chat/completions`, authenticated with `Authorization: Bearer <key>`:

```bash
curl http://GATEWAY_HOST:18771/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR-CLIENT-KEY" \
  -d '{
    "model": "gemini-2.0-flash",
    "messages": [
      { "role": "system", "content": "Be brief." },
      { "role": "user", "content": "Say hello" }
    ]
  }'
```

Requests arrive as OpenAI chat completions, are routed through the same key pool, and come back as standard OpenAI responses (`choices[].message.content`, `usage`, `finish_reason`). System messages map to Gemini system instructions; `temperature`, `top_p`, `max_tokens`/`max_completion_tokens`, and `stop` map to generation config. Errors use OpenAI's envelope:

```json
{ "error": { "message": "...", "type": "rate_limit_error", "code": 429 } }
```

## Proxy-origin errors

Errors originating from either gateway (bad client key, no credentials configured, deadline exhausted) share one normalized envelope with an HTTP-aligned numeric code:

```json
{ "error": { "code": 503, "message": "No provider credentials configured", "requestId": "..." } }
```

Admin API lives under `/api/admin/v1/*` on the dashboard port and requires the session cookie issued by `POST /api/admin/v1/login`; mutations additionally require the `x-csrf-token` header.

---

# Ports and Exposure

The three surfaces exist so you can expose exactly what the internet needs:

* **Expose**: the gateway ports (`18770`, `18771`) — they only accept proxy client keys.
* **Keep local** (recommended): the dashboard port (`18765`) — it holds admin power (credentials management, logs with payloads).

Ways to keep the dashboard private while managing a remote server:

1. **Bind to loopback** (default): `ADMIN_HOST=127.0.0.1`, then use an SSH tunnel: `ssh -L 18765:127.0.0.1:18765 user@server`.
2. **Reverse proxy** with its own authentication in front of `/`, keeping the port firewalled.
3. **Docker Compose**: publish with a host-side loopback prefix — `- "127.0.0.1:18765:18765"` — which is what the shipped compose file does. Inside the container all surfaces bind `0.0.0.0` so publishing works; restriction happens at the host port level.

---

# Key Selection and Cooldowns

For each model the proxy picks the credential with the fewest successful requests in the current window (least-used rotation). If that attempt fails, the next-best candidate is tried until `KEY_FALLBACK_ATTEMPTS` attempts or `KEY_LOOP_DEADLINE_MS` is exhausted; the last upstream response is relayed as-is.

| Failure | Classification | Cooldown |
| --- | --- | --- |
| 400 "API key not valid" | invalid_key | 60 s |
| Rate limit / 408 / 5xx | transient | 60 s |
| Daily quota exceeded | daily_quota | Until midnight Pacific |
| Other 4xx | permanent | none |

Cooled-down keys drop out of rotation but remain last-resort candidates (soonest expiry first). Expired cooldowns are promoted back to ready automatically.

---

# Database and Backups

SQLite at `DB_PATH` (default `/data/gemini-proxy.db` in Docker). Migrations run automatically at startup and are versioned in the `schema_version` table.

Back up by copying the database file while the proxy is stopped, or online:

```bash
sqlite3 data/gemini-proxy.db ".backup 'data/backup-$(date +%F).db'"
```

The database holds the admin password hash, client key hashes, usage counters, cooldown state, request logs, audit log, and **encrypted** provider credentials.

---

# Environment Variables

See `.env.example`. It is the single source of configuration: Docker Compose reads it automatically when placed next to `docker-compose.yml`, and running from source consumes the same variables. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_PORT` / `OPENAI_PORT` / `ADMIN_PORT` | `18770` / `18771` / `18765` | Listen ports for the three surfaces |
| `GATEWAY_HOST` | `0.0.0.0` | Bind address for both gateway surfaces |
| `ADMIN_HOST` | `127.0.0.1` | Bind address for dashboard/admin (keep local) |
| `DB_PATH` | `./data/gemini-proxy.db` | SQLite location |
| `SETUP_TOKEN` | required | Admin login password (seeded as a bcrypt hash on first start) |
| `APP_ENCRYPTION_KEY` | required in production | 32-byte base64 AES-256-GCM key for credentials at rest |
| `KEY_FALLBACK_ATTEMPTS` | `2` | Upstream attempts per request before relaying the last response |
| `KEY_LOOP_DEADLINE_MS` | `30000` | Total budget for all attempts |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-attempt upstream timeout |
| `MODELS_CACHE_TTL_HOURS` | `24` | Model cache freshness |
| `LOG_LEVEL` | `info` (`debug` in dev) | `fatal`/`error`/`warn`/`info`/`debug`/`trace` |
| `MAX_LOG_ENTRIES` | `1000` | Request-log retention (oldest pruned) |
| `LOG_BODY_MAX_BYTES` | `65536` | Stored bytes per request/response body |
| `MAX_BODY_BYTES` / `MAX_RESPONSE_BYTES` | 10 MB / 50 MB | Payload limits |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |

All secrets are masked in logs. Readiness (`/health/ready` on the admin port) checks database, schema version, and encryption availability.

---

# CI

GitHub Actions runs typecheck (server + web), ESLint, Vitest, the dashboard build, and a fresh-database migration smoke test on every push/PR: `.github/workflows/ci.yml`. Container images publish to GHCR on `main` and `v*.*.*` tags.

---

# Security

* **Surface isolation**: gateway ports speak only the API protocols and accept only proxy client keys; dashboard/admin is a separate port you can keep loopback-only (see "Ports and Exposure").
* Admin auth: session cookie (`httpOnly`, SameSite=strict) + CSRF token cookie mirrored via `x-csrf-token`; login is rate-limited and audited.
* Client keys and passwords stored hashed (SHA-256 / bcrypt); lookups are hash-based so raw keys are never persisted.
* Provider credentials encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`).
* Helmet headers on every surface, CSP for the dashboard; body-size limits everywhere; per-IP rate limiting on all three surfaces.
* Do not expose port 18765 directly to the internet — keep it local or behind an authenticated proxy.

---

# Troubleshooting

* **401 Unauthorized** — missing/invalid client key; generate one under **Client Keys**.
* **Model not permitted** — the client key's allowlist doesn't include this model.
* **503 No API keys** — add a provider credential; cooled keys still count, this only appears with an empty pool.
* **Readiness failing on encryption** — set `APP_ENCRYPTION_KEY`.
* **Dashboard unreachable from another machine** — `ADMIN_HOST` defaults to `127.0.0.1` on purpose; use an SSH tunnel or a reverse proxy (see "Ports and Exposure").
* **Database read-only / SQLITE_CANTOPEN** — no action needed: the container entrypoint fixes `/data` ownership on startup and drops to an unprivileged user before running the server. If you override `user:` in Compose, point it at a uid that can write the mounted directory.

---

# Project

Repository: https://github.com/muhammad-sho/Gemini_proxy
