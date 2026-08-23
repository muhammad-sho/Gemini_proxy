# Gemini proxy app

Simple Docker app with a browser dashboard and a small SQLite database. It
accepts the normal Gemini `generateContent` request, verifies a local key,
replaces it with one of the configured Gemini keys, forwards the request, and
returns Gemini's response.

## Start

```bash
docker compose up -d --build
```

Open `http://SERVER_IP:8080/`. On the first visit, create the dashboard
account. Setup generates a local client API key for n8n; save it because it is
shown only once. Add Gemini keys from the dashboard.
Add the exact currently supported model name from your Gemini account in the
Models section before sending traffic.

## Client request

Use the normal Gemini URL, but point it at the proxy and send the local key:

```bash
curl -X POST \
  http://SERVER_IP:8080/v1beta/models/gemini-2.0-flash:generateContent \
  -H 'Content-Type: application/json' \
  -H 'x-proxy-api-key: the-client-key-generated-during-setup' \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

The proxy adds `x-goog-api-key` upstream. Each model has its own round-robin
cursor. RPM/RPD limits and cooldowns are tracked independently for every
model/key pair, so a key cooling down for one model can still serve another
model. A limit or cooldown of `0` means unlimited or disabled.

SQLite is stored in the Docker volume `gemini-proxy-data` and survives rebuilds.
Daily usage follows Gemini's documented midnight Pacific Time reset. Transient
overload/server errors retry across keys and cool down that model/key for 30
seconds. Daily quota errors cool down that model/key until the next Pacific
midnight.

## Production security

The repository contains no runtime credentials. Gemini keys are entered after
first-run setup and stored in the private SQLite volume, not in the image or
source tree. Protect that volume and back it up securely. Put the service behind
an HTTPS reverse proxy, restrict dashboard access with firewall rules or a VPN,
and expose only ports 80/443 publicly. Do not expose the plain HTTP port 8080
to the public internet unless it is only a temporary, trusted-network test.
