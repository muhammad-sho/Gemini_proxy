# Gemini proxy app

Simple Docker app with a browser dashboard and a small SQLite database. It
accepts the normal Gemini `generateContent` request, verifies a local key,
replaces it with one of the configured Gemini keys, forwards the request, and
returns Gemini's response.

## Start

Normal server installation pulls the published GHCR image:

```bash
mkdir gemini-proxy
cd gemini-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/docker-compose.yml
docker compose up -d
```

The image name is:

```text
ghcr.io/muhammad-sho/gemini-proxy:latest
```

The repository includes a GitHub Actions workflow that publishes this image
after a successful push to `main`. The first installation must wait until that
workflow succeeds; the repository must not document the image as available
before that point.

For local development, build instead:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Open `http://SERVER_IP:18765/`. On the first visit, create the dashboard
account. Setup generates a local client API key for n8n; save it because it is
shown only once. Add Gemini keys from the dashboard.
Add the exact currently supported model name from your Gemini account in the
Models section before sending traffic.

## Client request

Use the normal Gemini URL, but point it at the proxy and send the local key:

```bash
curl -X POST \
  http://SERVER_IP:18765/v1beta/models/gemini-2.0-flash:generateContent \
  -H 'Content-Type: application/json' \
  -H 'x-proxy-api-key: the-client-key-generated-during-setup' \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

The proxy adds `x-goog-api-key` upstream. Each model has its own round-robin
cursor. RPM/RPD limits and cooldowns are tracked independently for every
model/key pair, so a key cooling down for one model can still serve another
model. A limit or cooldown of `0` means unlimited or disabled.

SQLite is stored directly at `./local-gemini-proxy.db` and survives container
restarts, recreations, and image upgrades. Compose mounts the deployment
directory so SQLite's database, WAL, and journal files all remain beside the
database. The image startup creates the file when needed, makes the mounted
directory writable when it is root-owned, and then runs Node as an
unprivileged user. The `:Z` mount label also handles SELinux hosts such as
Fedora/RHEL, where an unlabeled bind mount can make SQLite appear read-only.
No `chmod`, `chown`, data directory, or manual database creation is required.
Daily usage follows Gemini's documented midnight Pacific Time reset. Transient
overload/server errors retry across keys and cool down that model/key for 30
seconds, using the model's configured `cooldown_seconds` value. Daily quota
errors cool down that model/key until the next Pacific midnight.

## Production security

The repository contains no runtime credentials. Gemini keys are entered after
first-run setup and stored in plaintext in the private SQLite volume because
the proxy must recover them for upstream authentication. Protect that volume
and back it up securely. The app intentionally listens on `0.0.0.0:18765` for
self-hosted/container use, and the Compose mapping publishes that port on all
host interfaces. Put it behind an HTTPS reverse proxy, restrict dashboard
access with firewall rules or a VPN, and expose only ports 80/443 publicly. Do
not expose plain HTTP port 18765 to the public internet except for a temporary,
trusted-network test.
