# Gemini Proxy

A self-hosted Gemini API proxy that pools multiple Google Gemini API keys behind one stable endpoint. It picks the best available key for every request, handles rate limits and cooldowns automatically, and speaks the standard Gemini API — so any app that can call Gemini can use it without changes.

## Features

* Multiple Gemini API keys pooled behind one proxy endpoint
* **Least-used rotation per model** — each model independently uses the key with the fewest successful requests today
* Automatic retry on another key when one fails
* Automatic cooldown when a key is overloaded or out of daily quota
* Per-key and per-model usage tracking in a web dashboard
* Automatic model discovery from Google, served from a local cache so `/v1beta/models` answers instantly
* Web dashboard for managing keys, usage, and cooldown status
* SQLite storage — no external database needed
* Docker and Docker Compose support
* Simple API authentication with your own proxy API keys

---

## How It Works

The proxy sits between your application and Google's Gemini API:

```text
┌──────────────┐
│   Your App   │
│  (any tool)  │
└──────┬───────┘
       │
       │ Gemini API request
       │ x-proxy-api-key: <client key>
       ▼
┌──────────────────────┐
│    Gemini Proxy      │
│                      │
│  Auth check          │
│  Key selection       │
│  Retry / cooldown    │
└──────────┬───────────┘
           │
     ┌─────┼─────┬─────┐
     ▼     ▼     ▼     ▼
   Key 1  Key 2  Key 3  Key 4
     │     │     │     │
     └─────┴─────┴─────┴─────┘
              │
              ▼
      Google Gemini API
```

Your application only needs to know the proxy URL and **one client API key**
(generated in the dashboard). The real Google keys stay on your server.

---

# Quick Start (Docker Compose)

You only need Docker installed.

## 1. Get the compose file and start

```bash
mkdir gemini-proxy && cd gemini-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/docker-compose.yml
docker compose up -d
```

This pulls the published image:

```text
ghcr.io/muhammad-sho/gemini-proxy:latest
```

> The image is built automatically after every push to `main`. A brand-new
> repository must wait until that first build succeeds before pulling works.
> Version tags are also published for `v*.*.*` releases.

Check the logs:

```bash
docker compose logs -f
```

The dashboard will be available on:

```text
http://YOUR_SERVER_IP:18765
```

## 2. First-time setup

1. Open `http://YOUR_SERVER_IP:18765`.
2. If asked for a **setup token**, read it from the logs:
   ```bash
   docker compose logs gemini-proxy | grep "setup token"
   ```
3. Create your administrator account (username + password of at least 8
   characters), then sign in.
4. Open **Gemini API Keys** and add your Google Gemini keys.
5. Open **Client Keys** and generate a key for your application. Every key has
   a **Copy Key** button, so you can copy it again anytime.

Done — start sending requests.

### Run from source instead (development)

```bash
git clone https://github.com/muhammad-sho/Gemini_proxy.git
cd Gemini_proxy
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Or run directly with Node.js 22+ (no packages to install):

```bash
node server.js
```

---

# Dashboard

Open `http://YOUR_SERVER_IP:18765` and sign in. The dashboard has three tabs:

| Tab | What it does |
| --- | --- |
| **Overview & Usage** | Totals (client keys, Gemini keys, models, requests today), reset schedule, model sync time, plus the per model/key usage table with cooldown states |
| **Client Keys** | Generate and manage the API keys your applications use |
| **Gemini API Keys** | Add, enable/disable, and remove your Google Gemini keys |

Add your Google keys through the dashboard instead of pasting them directly
into your applications or workflows.

---

# API Usage

The proxy exposes the Gemini API using the standard Gemini request format.
Point any Gemini-compatible app at the proxy and swap two things: the URL and
the key.

```bash
curl http://127.0.0.1:18765/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-proxy-api-key: YOUR-CLIENT-KEY" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Say hello"
          }
        ]
      }
    ]
  }'
```

The response is Google's response, unchanged. Your app never sees which
Google key handled the request.

---

# Key Selection

The proxy does **not** rotate round-robin. For each model it selects the key
with the **fewest successful requests since the current daily window began**,
so all your keys are consumed evenly:

```text
Key usage today for gemini-2.0-flash:
  Key 1: 40   Key 2: 35   Key 3: 35   ← next request goes here
```

Usage is tracked per **model + key** combination, independently:

```text
Key 1 + gemini-2.0-flash
Key 1 + gemini-2.0-flash-lite
Key 2 + gemini-2.0-flash
Key 2 + gemini-2.0-flash-lite
```

A limit reached on one combination never affects the others. Only successful
requests count — failures do not.

At every reset moment (midnight Pacific time) the proxy clears the previous
day's usage records and expires finished cooldowns, so all keys start the new
day at zero automatically — no restart needed.

---

# Cooldowns and Retries

When a key fails, the proxy marks that model/key combination unavailable,
picks another key, and retries:

| Failure | Cooldown |
| --- | --- |
| Overload / rate-limit / server errors (408, 429, 5xx) | 60 seconds |
| Daily quota exceeded | Until Gemini's next midnight Pacific reset |

This prevents a temporarily limited key from repeatedly receiving requests.

---

# Models

Models are **not** configured manually. The model list is discovered from
Google and **cached locally**, so calls to `GET /v1beta/models` (like the ones
n8n makes during setup) return instantly instead of waiting for Google.

* First call with no cache: fetches from Google once, then caches.
* Every later call: served from cache — no delay.
* The cache refreshes itself in the background when it gets older than 24
  hours (`MODELS_CACHE_TTL_HOURS`, see settings). Your request is never
  delayed by a refresh.
* Want to force it? Use the **Refresh** button next to *Model Sync* on the
  dashboard's Overview tab.

The proxy also removes models that Google no longer offers and records the
sync time shown in the dashboard.

---

# Database

The proxy uses SQLite (stored at `./data/local-gemini-proxy.db` next to your
`docker-compose.yml`) to persist:

* Administrator account
* Client API keys
* Gemini API keys
* Usage records and cooldown state

The directory is mounted as a bind mount by Docker Compose, survives restarts
and image upgrades, and needs no manual permission fixes. Back up the `data/`
folder to back up everything.

Do not delete the database unless you intentionally want to reset the proxy's
stored state.

---

# Environment Variables

All configuration is optional; normal operation needs nothing beyond the
dashboard setup. Add these to the `environment:` section of
`docker-compose.yml` if needed:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `18765` | Port the proxy listens on |
| `DB_PATH` | `/data/local-gemini-proxy.db` | SQLite database location inside the container |
| `SETUP_TOKEN` | random, printed to logs | Your own token required to complete first-time setup |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy to honor `X-Forwarded-For` |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `MAX_BODY_BYTES` | `10485760` | Maximum accepted request body size |
| `MAX_RESPONSE_BYTES` | `52428800` | Maximum forwarded response size |
| `MODELS_CACHE_TTL_HOURS` | `24` | Hours before the cached model list refreshes in the background |

See `.env.example` for a starting point.

---

# Docker Commands

Start:

```bash
docker compose up -d
```

Update to the latest image (data is kept):

```bash
docker compose pull && docker compose up -d
```

View logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

Restart:

```bash
docker compose restart
```

---

# Security

API requests require a valid client key sent as:

```text
x-proxy-api-key: YOUR-CLIENT-KEY
```

Client keys and passwords are stored hashed; sign-in is protected by session
cookies, CSRF tokens, and login rate limiting.

Google Gemini API keys are stored in the local SQLite database in plaintext
because the proxy must recover them to authenticate upstream. Protect the
server and back the database up securely.

Do not expose port `18765` straight to the public internet. Put it behind an
HTTPS reverse proxy or keep it on a trusted network / VPN.

---

# Troubleshooting

## 401 Unauthorized

Check that the request contains the `x-proxy-api-key` header and that the
value matches a client key generated in the dashboard (**Client Keys** tab).

## 503 No enabled Gemini API keys

No usable Google keys are configured or all matching keys are cooling down.
Add keys in the **Gemini API Keys** tab and check the Overview & Usage table
for cooldown states.

## Rate Limit Errors

Check the dashboard for the affected model/key combination. The proxy already
rotated to another available key when possible.

## Database Is Read-Only

Make sure the directory containing the SQLite database is writable by the
container. The provided Compose file handles this automatically, including on
SELinux hosts via the `:Z` mount label.

---

# Project

Repository:

https://github.com/muhammad-sho/Gemini_proxy
