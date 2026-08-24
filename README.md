# Gemini Proxy

A self-hosted Gemini API proxy that pools multiple Google Gemini API keys behind one stable endpoint. It picks the best available key for every request, handles rate limits and cooldowns automatically, and speaks the standard Gemini API — so any app that can call Gemini can use it without changes.

## Features

* Multiple Gemini API keys pooled behind one proxy endpoint
* **Best-key selection** — ready keys first (least-used rotation per model); if none are ready, cooled keys are still tried as last resort, soonest-expiring cooldown first
* Automatic retry on another key when one fails (`KEY_FALLBACK_ATTEMPTS`)
* Automatic cooldown when a key hits rate limits, transient errors, or daily quota
* Google's responses — successes and errors alike — are relayed to the client byte-for-byte
* Per-key and per-model usage tracking in a web dashboard
* Model discovery from Google, served from a local cache so `/v1beta/models` answers instantly
* Web dashboard: overview stats, client keys, provider credentials, model cache, request logs with timeline and payload inspection
* SQLite storage — no external database needed
* Provider credentials encrypted at rest (AES-256-GCM)
* Docker and Docker Compose support, non-root container with healthcheck
* Client authentication with your own proxy API keys

---

## Architecture

The server is a modular TypeScript/Fastify application. Request flow:
route → auth → validation → use case → router/adapters → repositories.

```text
src/
├── main.ts                  bootstrap + graceful shutdown
├── config/env.ts            Zod-validated environment configuration
├── shared/                  types, crypto (AES-GCM, hashing), time helpers
├── infrastructure/
│   ├── db/                  SQLite connection, numbered migrations, repositories
│   ├── logging/             pino logger with secret masking
│   └── providers/           gemini + openai-compatible upstream adapters
├── domain/
│   ├── auth/                admin sessions
│   ├── providers/           adapter interface + error classification
│   └── routing/             cooldown policies + key selection ordering
├── application/gateway/     routing service (retries/deadline/logging), model cache service
└── http/
    ├── server.ts            Fastify composition root (helmet CSP, rate limit, static SPA)
    └── routes/              health, gateway, auth, admin
web/                         React 19 + Vite dashboard (built to dist-web/)
```

Upstream responses are relayed verbatim; the proxy never rewrites bodies.
Every attempt is logged with a trace id, timeline events, classification,
latency, and truncated/masked payloads.

---

# Quick Start (Docker Compose)

You only need Docker installed.

```bash
mkdir gemini-proxy && cd gemini-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/docker-compose.yml
SETUP_TOKEN=choose-a-long-secret APP_ENCRYPTION_KEY=$(openssl rand -base64 32) docker compose up -d
```

* `SETUP_TOKEN` — the admin password used to log into the dashboard.
* `APP_ENCRYPTION_KEY` — encrypts the Google API keys you add later (required in production).

Check `docker compose logs -f`, then open `http://YOUR_SERVER_IP:18765`.

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

Sign in at `http://YOUR_SERVER_IP:18765`. Tabs:

| Tab | What it does |
| --- | --- |
| **Overview** | Totals (client keys, providers, models, requests today), active cooldowns, usage per model/key, refresh-models and clear-cooldowns actions |
| **Client keys** | Generate/revoke the API keys your applications use; restrict by model or group |
| **Providers** | Add/remove Google Gemini (or OpenAI-compatible) credentials; optional per-credential base URL and model allowlist |
| **Models** | Cached model list from Google with manual refresh |
| **Logs** | Every request with outcome/status/attempt filters and body search; click a row for the full timeline and payloads |

---

# API Usage

Point any Gemini-compatible app at the proxy and swap two things: the URL and the key. Supported endpoints: `GET /v1beta/models` and `POST /v1beta/models/{model}:generateContent`. Streaming (`streamGenerateContent`) and `countTokens` are not proxied.

The client key can be sent as `x-goog-api-key`, `Authorization: Bearer <key>`, or `?key=`:

```bash
curl http://127.0.0.1:18765/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: YOUR-CLIENT-KEY" \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

The response is Google's response, unchanged — including errors after all retries fail. Errors originating from the proxy use a normalized envelope:

```json
{ "error": { "code": 503, "message": "No API keys configured", "requestId": "..." } }
```

Admin API lives under `/api/admin/*` and requires the session cookie issued by `POST /api/admin/login`; mutations additionally require the `x-csrf-token` header.

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

See `.env.example`. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `18765` | Listen port |
| `DB_PATH` | `./data/gemini-proxy.db` | SQLite location |
| `SETUP_TOKEN` | required | Admin login password (seeded as a bcrypt hash on first start) |
| `APP_ENCRYPTION_KEY` | required in production | 32-byte base64 AES-256-GCM key for credentials at rest |
| `KEY_FALLBACK_ATTEMPTS` | `2` | Upstream attempts per request before relaying the last response |
| `KEY_LOOP_DEADLINE_MS` | `30000` | Total budget for all attempts |
| `REQUEST_TIMEOUT_MS` | `60000` | Per-attempt upstream timeout |
| `MODELS_CACHE_TTL_HOURS` | `24` | Model cache freshness |
| `MAX_LOG_ENTRIES` | `1000` | Request-log retention (oldest pruned) |
| `LOG_BODY_MAX_BYTES` | `65536` | Stored bytes per request/response body |
| `MAX_BODY_BYTES` / `MAX_RESPONSE_BYTES` | 10 MB / 50 MB | Payload limits |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |

All secrets are masked in logs. Readiness (`/health/ready`) checks database, schema version, and encryption availability.

---

# CI

GitHub Actions runs typecheck (server + web), ESLint, Vitest, the dashboard build, and a fresh-database migration smoke test on every push/PR: `.github/workflows/ci.yml`. Container images publish to GHCR on `main` and `v*.*.*` tags.

---

# Security

* Admin auth: session cookie (`httpOnly`, SameSite=Lax) + CSRF token cookie mirrored via `x-csrf-token`; login is rate-limited and audited.
* Client keys and passwords stored hashed (SHA-256 / bcrypt); lookups are hash-based so raw keys are never persisted.
* Provider credentials encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`).
* Helmet CSP, strict response headers, body-size limits everywhere.
* Do not expose port 18765 directly to the internet — put it behind an HTTPS reverse proxy or keep it on a trusted network.

---

# Troubleshooting

* **401 Unauthorized** — missing/invalid client key; generate one under **Client Keys**.
* **Model not permitted** — the client key's allowlist doesn't include this model.
* **503 No API keys** — add a provider credential; cooled keys still count, this only appears with an empty pool.
* **Readiness failing on encryption** — set `APP_ENCRYPTION_KEY`.
* **Database read-only / SQLITE_CANTOPEN** — no action needed: the container entrypoint fixes `/data` ownership on startup and drops to an unprivileged user before running the server. If you override `user:` in Compose, point it at a uid that can write the mounted directory.

---

# Project

Repository: https://github.com/muhammad-sho/Gemini_proxy
