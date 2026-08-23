# Gemini Proxy

A self-hosted Gemini API proxy that automatically rotates multiple Google Gemini API keys, tracks per-model quotas, handles rate limits and cooldowns, and provides a standard Gemini-compatible API for applications such as n8n.

## Features

* Multiple Gemini API keys
* Automatic API key rotation
* **Independent round-robin rotation per model**
* Per-key and per-model usage tracking
* RPM and RPD limit tracking
* Automatic cooldown when a key hits a limit or returns a rate-limit error
* Automatic retry with another available key
* Web dashboard for managing keys and models
* SQLite database for persistent configuration and usage
* Docker and Docker Compose support
* Simple API authentication with your own proxy API key
* Works with n8n and other applications that support the Gemini API

---

## How It Works

The proxy sits between your application and Google's Gemini API:

```text
┌──────────────┐
│     n8n      │
│  AI Agent    │
└──────┬───────┘
       │
       │ Gemini API request
       ▼
┌──────────────────────┐
│     Gemini Proxy     │
│                      │
│  Model selection     │
│  Key rotation        │
│  Rate-limit tracking │
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

Your application only needs to know the proxy URL and **one proxy API key**.

The proxy handles the Google Gemini API keys internally.

---

# Quick Start

## 1. Clone the repository

```bash
git clone https://github.com/muhammad-sho/Gemini_proxy.git
cd Gemini_proxy
```

## 2. Configure the environment

Create your `.env` file:

```bash
cp .env.example .env
```

Edit it:

```bash
nano .env
```

Set your proxy API key and other required values.

## 3. Start the proxy

```bash
docker compose up -d --build
```

Check the logs:

```bash
docker compose logs -f
```

The proxy will be available on:

```text
http://YOUR_SERVER:8080
```

---

# Dashboard

Open:

```text
http://YOUR_SERVER:8080
```

The dashboard allows you to manage:

* Gemini API keys
* Gemini models
* Proxy configuration
* Usage information
* Key/model status

Add your Gemini API keys through the dashboard instead of putting them directly into your n8n workflows.

---

# API Usage

The proxy exposes the Gemini API using the standard Gemini request format.

For example:

```bash
curl http://127.0.0.1:8080/v1beta/models/gemini-3.6-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-proxy-api-key: YOUR_APP_API_KEY" \
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

Replace:

```text
YOUR_APP_API_KEY
```

with the API key configured for the proxy.

---

# Using It With n8n

Instead of calling Google directly:

```text
n8n
  │
  ▼
Google Gemini API
```

use:

```text
n8n
  │
  ▼
Gemini Proxy
  │
  ├── Gemini Key 1
  ├── Gemini Key 2
  ├── Gemini Key 3
  └── Gemini Key 4
       │
       ▼
Google Gemini API
```

Set the Gemini API URL to:

```text
http://YOUR_PROXY_HOST:8080/v1beta/
```

Use your proxy API key:

```text
x-proxy-api-key: YOUR_APP_API_KEY
```

The Gemini keys themselves do **not** need to be placed inside n8n.

---

# API Key Rotation

The proxy rotates keys automatically.

For example, if three keys are configured for:

```text
gemini-3.6-flash
```

requests are distributed like:

```text
Request 1 → Key 1
Request 2 → Key 2
Request 3 → Key 3
Request 4 → Key 1
Request 5 → Key 2
Request 6 → Key 3
```

## Rotation Is Per Model

Each model has its own independent rotation.

For example:

```text
gemini-3.6-flash

Key 1 → Key 2 → Key 3 → Key 1
```

and independently:

```text
gemini-3.6-flash-lite

Key 1 → Key 2 → Key 3 → Key 1
```

A request using one model does **not** advance the rotation position of another model.

---

# Rate Limits

Usage is tracked independently for each:

```text
Model + API Key
```

For example:

```text
Key 1 + gemini-3.6-flash
Key 1 + gemini-3.6-flash-lite
Key 2 + gemini-3.6-flash
Key 2 + gemini-3.6-flash-lite
```

Each combination has its own usage state.

This means a limit reached on:

```text
Key 1 + gemini-3.6-flash
```

does not automatically make:

```text
Key 1 + gemini-3.6-flash-lite
```

unavailable.

---

# RPM and RPD

The proxy tracks:

* **RPM** — Requests Per Minute
* **RPD** — Requests Per Day

When a key reaches a configured limit, the proxy avoids using that key for the affected model and attempts to use another available key.

---

# Cooldowns and Retries

If Gemini returns a rate-limit or temporary availability error, the proxy can:

1. Mark the affected key/model combination as unavailable.
2. Put it into cooldown.
3. Select another available key.
4. Retry the request.

This prevents a temporarily limited key from repeatedly receiving requests.

---

# Model Configuration

Models are configured through the dashboard.

Examples:

```text
gemini-2.5-flash
gemini-2.5-flash-lite
gemini-3-flash-preview
gemini-3.1-flash-lite
gemini-3.5-flash
gemini-3.5-flash-lite
gemini-3.6-flash
```

The model name used by your application must match a model configured in the proxy.

---

# Database

The proxy uses SQLite to store persistent data.

The database contains information such as:

* API keys
* Models
* Usage
* Rotation state
* Cooldowns
* Configuration

Make sure the SQLite database is stored on a persistent Docker volume.

Do not delete the database unless you intentionally want to reset the proxy's stored state.

---

# Docker

Start:

```bash
docker compose up -d
```

Rebuild after changes:

```bash
docker compose up -d --build
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

# Environment Variables

Configuration is provided through `.env`.

Example:

```env
APP_API_KEY=your-secret-proxy-key
PORT=8080
```

See `.env.example` for the complete list of supported variables.

---

# Security

The proxy API requires the configured application API key.

Use:

```text
x-proxy-api-key
```

for API requests.

Example:

```text
x-proxy-api-key: YOUR_APP_API_KEY
```

Do not expose the proxy directly to the public internet without appropriate network security.

The Gemini API keys stored by the proxy should also be treated as sensitive credentials.

---

# Troubleshooting

## 401 Unauthorized

Check that the request contains:

```text
x-proxy-api-key
```

and that the value matches the proxy's configured `APP_API_KEY`.

## 404 Model Not Found

Make sure the requested model exists in the proxy configuration and that the URL uses the correct model name:

```text
/v1beta/models/MODEL_NAME:generateContent
```

## Rate Limit Errors

Check the dashboard for the affected model/key combination.

The proxy will rotate to another available key when possible.

## Database Is Read-Only

Make sure the directory containing the SQLite database is writable by the Docker container and is mounted as a persistent volume.

---

# Example Request

```bash
curl http://127.0.0.1:8080/v1beta/models/gemini-3.6-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-proxy-api-key: your-app-api-key" \
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

The application does not need to know which Gemini API key will process the request.

The proxy selects the appropriate key automatically.

---

# Architecture

```text
                    ┌─────────────────┐
                    │      Client     │
                    │   n8n / App     │
                    └────────┬────────┘
                             │
                             │ x-proxy-api-key
                             ▼
                    ┌─────────────────┐
                    │  Gemini Proxy   │
                    ├─────────────────┤
                    │ Model Selection │
                    │ Key Rotation    │
                    │ Rate Tracking   │
                    │ Cooldowns       │
                    │ Retry Handling  │
                    └───────┬─────────┘
                            │
                ┌───────────┼───────────┐
                │           │           │
                ▼           ▼           ▼
             API Key 1   API Key 2   API Key 3
                │           │           │
                └───────────┼───────────┘
                            ▼
                    Google Gemini API
```

---

# Project

Repository:

https://github.com/muhammad-sho/Gemini_proxy

## License

See the repository for license information.
