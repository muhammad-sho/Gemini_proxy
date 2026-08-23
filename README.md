# Gemini Proxy

Use many Gemini API keys as if they were one. Gemini Proxy runs on your own
server, gives you a single URL and a single API key for your apps, and picks
the best Google key behind the scenes.

```
Your apps  ──▶  Gemini Proxy  ──▶  Google Gemini
             (your server)      (rotates keys)
```

Works with any tool that already speaks the Gemini API – automations, scripts,
SDKs, chat UIs, you name it.

## Why use it?

- **One key for everything** – your apps use one proxy key. Your real Google
  keys stay private on your server.
- **Never hit a quota wall** – when one key gets busy or runs out for the day,
  the next key takes over automatically.
- **Fair sharing** – each model uses the key that has done the least work
  today, so all your keys last longer.
- **See everything** – a built-in web page shows requests, usage per key, and
  cooldowns.
- **Easy install** – one Docker Compose file. No coding needed.
- **Free and light** – no paid services, no extra databases. Everything is in
  one small container.

## Setup with Docker Compose (easiest way)

You only need Docker installed. Copy these commands:

```bash
mkdir gemini-proxy && cd gemini-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/Gemini_proxy/main/docker-compose.yml
docker compose up -d
```

That's it. The app is now running on port `18765`.

> **Note:** the first install needs the published image to exist. It is built
> automatically after every push to `main`, so wait for that workflow to
> finish before your first `docker compose up`.

### Create your admin account

1. Open `http://YOUR_SERVER_IP:18765` in your browser.
2. If the page asks for a **setup token**, get it from the logs:
   ```bash
   docker compose logs gemini-proxy | grep "setup token"
   ```
3. Pick a username and a password (at least 8 characters). This creates your
   account – then sign in.

Done! Now, inside the dashboard:

- Go to **Gemini API Keys** and add your Google Gemini keys.
- Go to **Client Keys** and generate a key for your apps. Every key has a
  **Copy Key** button, so you can grab it again anytime.

## How to use it

Any app that can call the Gemini API can use the proxy. Just change two
things: the URL points to your server, and the key is your client key.
Everything else stays exactly the same as a normal Gemini request.

```bash
curl -X POST \
  http://YOUR_SERVER_IP:18765/v1beta/models/gemini-2.0-flash:generateContent \
  -H 'Content-Type: application/json' \
  -H 'x-proxy-api-key: YOUR-CLIENT-KEY' \
  -d '{"contents":[{"parts":[{"text":"Say hello"}]}]}'
```

The response is Google's response, unchanged.

## Good to know

- **Daily reset**: usage counters follow Gemini's own schedule and reset at
  midnight Pacific time.
- **Cooldowns**: a key that fails with "busy" errors rests for 60 seconds. A
  key that hits its daily limit rests until the next Pacific midnight. Other
  keys keep working meanwhile.
- **Models update themselves**: the model list is refreshed from Google every
  time something asks for `/v1beta/models`.
- **Your data stays home**: settings and keys live in a small database file at
  `./data/` next to your `docker-compose.yml`. Back up that folder and you
  have backed up everything.
- **Updating**: run `docker compose pull && docker compose up -d`. Your data
  is kept.

## Settings (optional)

Everything works without any configuration. If you want to tweak, add these
to the `environment:` section of your `docker-compose.yml`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `18765` | Port the proxy listens on |
| `SETUP_TOKEN` | random (in logs) | Your own token for first-time setup |
| `TRUST_PROXY` | off | Set to `1` if you serve through a reverse proxy |
| `REQUEST_TIMEOUT_MS` | `120000` | Wait time for Google's answer |

## Run your own copy for development

```bash
git clone https://github.com/muhammad-sho/Gemini_proxy.git
cd Gemini_proxy
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Or with Node.js 22+ directly (no packages to install):

```bash
node server.js
```

## Security in short

- Your Google keys are stored only inside the database on your own server,
  because the proxy needs them to talk to Google. Keep the server safe and
  back the `./data` folder up securely.
- Do not expose port `18765` straight to the internet. Put it behind an HTTPS
  reverse proxy or keep it inside your local network / VPN.
