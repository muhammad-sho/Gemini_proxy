# Gemini Proxy

A lightweight, self-hosted proxy that sits in front of the Google Gemini API
and pools multiple Gemini API keys behind one stable endpoint. Apps send a
normal Gemini `generateContent` request with a local proxy key; the proxy
verifies it, swaps in the best available Gemini key, forwards the request, and
returns Gemini's response unchanged.

Runs as a single Docker container with zero npm dependencies (Node.js
built-ins only) and a small SQLite database. Ships with a browser dashboard
for key management and live usage telemetry.

## Features

- **Drop-in Gemini compatibility** — same `/v1beta/models/{model}:generateContent`
  request shape; only the upstream API key is replaced.
- **Smart key rotation** — for each model, requests go to the eligible key
  with the fewest successful calls since the last daily reset. Usage is
  tracked per model independently, so heavy use of one model never starves
  another.
- **Automatic failover** — if a key fails, the request is retried on the next
  key. Transient overloads cool that model/key down for 60 seconds; quota
  failures cool it down until Gemini's next midnight Pacific reset.
- **Auto model discovery** — calling `/v1beta/models` syncs the real model
  list from Google, removes models that no longer exist, and records the
  exact sync time shown in the dashboard. Models are never added manually.
- **Web dashboard** — first visit creates the admin account. Add, enable,
  disable, or remove Gemini keys, issue local client keys, and watch per-key
  usage, cooldown reasons, and the upcoming reset time.
- **n8n ready** — works with n8n's **Google Gemini (PaLM) API** credential by
  just changing the host URL (see below).
- **Hardened by default** — scrypt-hashed passwords, session cookies with CSRF
  protection, login rate limiting, strict security headers, SHA-256-hashed
  client keys (shown once at creation), and an optional one-time setup token.
- **Persistent by design** — SQLite (WAL mode) lives in a bind-mounted
  `./data` directory and survives restarts, recreations, and image upgrades.
  No manual `chmod`/`chown`; the entrypoint fixes permissions and drops to an
  unprivileged user. Works on SELinux hosts (Fedora/RHEL) via the `:Z` label.

## Quick start

Requirements: Docker and Docker Compose.

```bash
mkdir gemini-proxy && cd gemini-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/docker-compose.yml
docker compose up -d
```

This pulls the published image:

```text
ghcr.io/muhammad-sho/gemini-proxy:latest
```

A GitHub Actions workflow publishes the image after every push to `main`. The
first installation must wait until that workflow succeeds.

### First-time setup

1. Open `http://SERVER_IP:18765/`.
2. If `SETUP_TOKEN` was not provided via environment, fetch the auto-generated
   one-time token from the container logs:

   ```bash
   docker compose logs gemini-proxy | grep "setup token"
   ```

3. Create the dashboard account (username + password of at least 8 characters).
4. Save the generated **client API key** — it is shown only once. This is the
   key your apps (and n8n) will use.
5. Add your Gemini API keys in the dashboard.

## Usage

Point any Gemini client at the proxy and send the client key instead of a
Google key:

```bash
curl -X POST \
  http://SERVER_IP:18765/v1beta/models/gemini-2.0-flash:generateContent \
  -H 'Content-Type: application/json' \
  -H 'x-proxy-api-key: the-client-key-generated-during-setup' \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

### Connect from n8n

In n8n's **Google Gemini (PaLM) API** credential:

- **Host**: your proxy URL, e.g. `http://192.168.100.14:18765`
- **API Key**: the client key generated during setup

The proxy accepts n8n's `GET /v1beta/models?key=...` connection test as well
as the standard `x-proxy-api-key` header used for requests.

## Key selection & cooldowns

- Only **successful** requests count toward usage; failures do not.
- Per model/key cooldowns:
  - Transient overload/server errors (408/429/5xx): 60 seconds.
  - Daily quota errors: until Gemini's next midnight Pacific reset.
- Daily usage follows Gemini's documented Pacific Time reset, so the
  dashboard's counters and reset time match Google's quotas.

## Configuration

All settings are optional environment variables; normal configuration happens
in the dashboard.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `18765` | HTTP port the server listens on |
| `DB_PATH` | `/data/local-gemini-proxy.db` (in-container) | SQLite database location |
| `SETUP_TOKEN` | random, printed to logs | Token required to complete first-time setup |
| `TRUST_PROXY` | unset | Set `1`/`true` to trust `X-Forwarded-For` behind a reverse proxy |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `MAX_BODY_BYTES` | `10485760` | Maximum accepted request body size |
| `MAX_RESPONSE_BYTES` | `52428800` | Maximum forwarded response size |

See `.env.example` for a starting point.

## Local development

Build locally instead of pulling the published image:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Or run directly with Node.js 22+ (uses only built-in modules):

```bash
node server.js
```

## Data & persistence

SQLite is stored at `./data/local-gemini-proxy.db` next to
`docker-compose.yml`. Docker creates `./data` automatically; the entrypoint
creates the database file, makes the mounted directory writable when
root-owned, then runs Node as an unprivileged user. Database, WAL, and journal
files stay host-visible together. Back up that directory to back up
everything (keys, accounts, usage).

## Production security

The repository contains no runtime credentials. Gemini keys are entered after
first-run setup and stored in plaintext in the private SQLite volume because
the proxy must recover them for upstream authentication — protect that volume
and back it up securely.

The app intentionally listens on `0.0.0.0:18765`, and Compose publishes that
port on all host interfaces. For public deployments:

- Put it behind an HTTPS reverse proxy.
- Restrict dashboard access with firewall rules or a VPN.
- Expose only ports 80/443 publicly; do not expose plain-HTTP port 18765 to
  the internet except for a temporary, trusted-network test.
