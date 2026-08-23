# Security Validation Report - Gemini Proxy App

**Date:** 2026-08-23
**Scope:** `server.js`, `dashboard.html`, `Dockerfile`, `entrypoint.sh`, `docker-compose.yml`, `docker-compose.dev.yml`, `.github/workflows/publish-ghcr.yml`, README claims.
**Method:** Static code review. No live instance was running at review time. Git history was checked for committed secrets - none found (`*.db` / `.env` are gitignored and were never committed).

---

## 1. Direct answer to the question

> "If this app worked with an HTTPS publicly reachable endpoint, is the app secured 100%?"

**No.** Two reasons:

1. **Nothing is ever "100% secure."** HTTPS only solves transport confidentiality and integrity (nobody can read or modify traffic on the wire). It does nothing about application logic flaws, secret handling, abuse prevention, or deployment mistakes.
2. **As currently shipped, HTTPS in front does not even fully apply**, because Compose still publishes the plain-HTTP port on ALL host interfaces (`docker-compose.yml` line 7: `"18765:18765"`). Anyone who can reach the HTTPS endpoint can usually also reach `http://same-host:18765/` and bypass TLS entirely - session cookies, dashboard logins, and client API keys would cross the internet in cleartext. Also note: Docker-published ports go through the FORWARD chain and typically **bypass UFW/firewalld INPUT rules**, so "just firewall it" often does not work as people expect.

**Verdict:** The app is reasonably well built for a self-hosted tool (see section 3), but with current defaults it can only be described as *"secure if deployed exactly as documented AND the HTTP port is closed"* - never as *"secured 100%."*

---

## 2. What HTTPS fixes vs. does not fix

| Fixed by HTTPS | NOT fixed by HTTPS |
|---|---|
| Eavesdropping on credentials/keys in transit | Plain-HTTP port still open alongside it |
| MITM tampering of requests/responses | Admin takeover during first-run setup window |
| Traffic injection on the wire | Rate-limit design flaws behind a reverse proxy |
| | Plaintext Gemini keys at rest in SQLite volume and backups |
| | Cookie `Secure` flag depends on proxy sending `X-Forwarded-Proto`; HSTS must be added at the proxy |
| | No logout endpoint; sessions persist up to 8h |
| | DoS vectors (blocking scrypt, memory buffering, limiter map growth) |
| | Supply-chain trust (unpinned base image tag, unsigned image) |

---

## 3. What the app does RIGHT (verified positives)

- **SQL injection:** every query is parameterized, including the one dynamic `IN (...)` clause built from `?` placeholders (server.js:332).
- **Password storage:** scrypt + per-user random salt + `crypto.timingSafeEqual` comparison (server.js:164-172).
- **Client API keys:** 256-bit random, SHA-256-hashed at rest, shown once, masked everywhere else (server.js:174-179).
- **CSRF:** double-submit cookie + session-bound token required for all non-GET `/api/admin/*` calls (server.js:136-141, 455-456).
- **Cookies:** session cookie is `HttpOnly; SameSite=Strict`; `Cache-Control: no-store` globally (server.js:87, 453).
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, CSP with `frame-ancestors 'none'` and `base-uri 'none'` (server.js:81-88).
- **Dashboard output escaping:** all interpolated values pass through `esc()` (dashboard.html:41,48-50) - no XSS found.
- **No SSRF:** upstream hostname is hardcoded to `generativelanguage.googleapis.com`; only path/query are forwarded; forwarded-header whitelist prevents leaking the local client key upstream; `?key=` is swapped to the real key before forwarding (server.js:254-266).
- **Body/response size caps** plus upstream request timeout (server.js:10-11, 90-104, 277-292).
- **Container privilege drop** via su-exec to the data-dir owner, DB chmod 600, SELinux `:Z` label support (entrypoint.sh).
- **Repo hygiene:** no secrets in working tree or git history; GHCR workflow uses least-privilege token permissions.
- **Admin API authz ordering is correct:** session check runs before any `/api/admin/*` handler; CSRF check runs before all mutating admin routes (server.js:455-456).

---

## 4. Findings

Severity assumes the README deployment model (behind an HTTPS reverse proxy, port 18765 closed externally).

### HIGH

**H1. Plain-HTTP port remains publicly exposed even when deployed behind HTTPS**
- Where: `docker-compose.yml` line 7 (`"18765:18765"` binds 0.0.0.0), server.js:496 listens on `0.0.0.0`.
- Impact: With a reverse proxy providing HTTPS, the raw HTTP port stays reachable. An attacker (or a careless user) can use `http://host:18765` directly: credentials, dashboard cookies, and client keys traverse the internet unencrypted, making the HTTPS layer pointless. Docker port publishing commonly bypasses host firewall INPUT rules (UFW), so this can be open even when the operator believes it is firewalled.
- Fix: Publish as `"127.0.0.1:18765:18765"` by default; document that clearly. Optionally have the app refuse requests whose `Host` header is not expected, or add a `TRUST_PROXY` / redirect mode.

**H2. First-run setup takeover window (unauthenticated `/api/setup`)**
- Where: server.js:430-440.
- Impact: Until the first admin exists, ANYONE who finds the public endpoint can create the admin account AND receive the generated client API key - which then lets them spend the real Gemini quota configured later. Internet-wide scanners find fresh deployments within minutes/hours. This is a classic installer-takeover risk that HTTPS does not address at all.
- Additional TOCTOU race: `hasAdmin()` is checked BEFORE `await readBody(...)`. Two concurrent setup requests can both pass the check; with different usernames both INSERTs succeed, producing two admins.
- Fix: Require a one-time setup token printed to container logs (`docker logs`) at startup, or an env-provided SETUP_TOKEN; do the hasAdmin check + insert atomically inside a transaction after the body is read.

**H3. Login rate-limiting is broken in both directions behind a reverse proxy / when exposed directly**
- Where: `clientAddress()` uses only `request.socket.remoteAddress` (server.js:143-145); no X-Forwarded-For support anywhere.
- Impact A (lockout DoS): behind a reverse proxy, ALL clients share the proxy's IP. After 10 total failures in 15 minutes from anyone, every legitimate login is rejected with 429 - trivial DoS against the owner.
- Impact B (brute force bypass): exposed directly, an attacker rotating IPv6 addresses (or a botnet) gets unlimited attempts because buckets are per exact socket address. Combined with no lockout alerts, password brute force becomes practical over time.
- Also: the `loginAttempts` Map never removes stale addresses (only each touched key's list is filtered) -> unbounded memory growth with many unique source addresses (slow memory-leak DoS).
- Fix: Support `X-Forwarded-For` behind a configurable trusted-proxy flag; add a global cap in addition to per-IP; use expiring LRU cleanup.

### MEDIUM

**M1. Gemini API keys stored in plaintext in SQLite (and WAL/journal files)**
- Where: schema server.js:23-29, insert server.js:473; acknowledged in README ("stored in plaintext").
- Impact: Any compromise of the container/host, any careless copy of `./data`, any unencrypted backup leaks ALL upstream keys. Note the repo working directory currently contains a dev database plus a 360KB WAL file - plaintext secrets sitting in a project folder is a hygiene accident waiting to happen even though it is gitignored.
- Mitigations available: OS-level encryption of the volume, encrypted backups, documented rotation procedure. Full fix would require a secrets manager (out of scope for a simple self-hosted app, but say so explicitly rather than implying it is safe).

**M2. Blocking `scryptSync` on the login path enables CPU-based DoS**
- Where: server.js:164-166 called synchronously from the request handler (server.js:447).
- Impact: Each login attempt with the valid username burns ~50-100ms of the single-threaded event loop. Enough parallel requests (rate limits are bypassable per H3) keep the process pinned at 100% CPU, stalling the proxy for everyone.
- Fix: use async `crypto.scrypt`, and/or move rate limiting in front of password hashing.

**M3. Cookie `Secure` flag depends on the proxy sending `X-Forwarded-Proto`; no HSTS**
- Where: server.js:452.
- Impact: If the reverse proxy does not set `X-Forwarded-Proto: https` (common misconfiguration), the session cookie is issued WITHOUT `Secure` and will be sent over any plain-HTTP request - which H1 makes realistic. HSTS must also be added at the proxy since the app cannot set it meaningfully over HTTP.
- Fix: document required proxy headers loudly; consider failing closed via an env flag like `REQUIRE_HTTPS=1`.

**M4. Client API key accepted via URL query parameter (`?key=`)**
- Where: server.js:110-118 (needed for n8n compatibility).
- Impact: URLs (and therefore keys) end up in reverse-proxy access logs, n8n execution history, browser history, and Referer headers. Key leakage into logs defeats the hashed-at-rest design for client keys.
- Fix: keep supporting it but warn in README/dashboard; prefer header-only mode when possible.

**M5. CSP allows `'unsafe-inline'` scripts; dashboard relies on inline event handlers**
- Where: CSP server.js:86; inline `onclick=` handlers dashboard.html:48-49.
- Impact: CSP provides little XSS defense-in-depth: any future HTML-injection bug immediately yields script execution. Currently mitigated because all output is escaped, but one missed `esc()` away from exploitation.
- Fix: refactor dashboard to external JS with `addEventListener`, then drop `'unsafe-inline'`.

**M6. No logout endpoint; sessions live 8h and survive only in memory**
- Where: routes in server.js:414-486 (no `/logout`); SESSION_TTL server.js:13.
- Impact: A stolen/lef-behind session cannot be revoked except by restarting the whole proxy (which also wipes rate-limit state). Conversely, restart wipes sessions - availability tradeoff, but revocation capability matters for an admin panel controlling real spend.
- Fix: add POST /logout (delete session + clear cookie); optionally a "revoke all sessions" button.

**M7. Unbounded memory buffering per request**
- Where: response buffering up to 50MB per request (server.js:11, 277-284); body buffered up to 10MB (server.js:10). No concurrent-request cap, no container memory limit in compose.
- Impact: A single valid client key (or leaked one) streaming several large responses concurrently can OOM the container/host. Oversized bodies are also fully drained before rejection instead of closing the connection early.
- Fix: add compose `mem_limit`/`pids_limit`; consider rejecting early with `connection.destroy()` on limit breach; cap concurrent upstream forwards.

**M8. Supply chain not pinned or signed**
- Where: `Dockerfile` line 1 (`node:22-alpine` - mutable tag, no digest), GHCR image tagged only `latest`, no cosign signature/SBOM/provenance in the publish workflow.
- Impact: Builds are not reproducible; consumers cannot verify what they run. For a tool whose whole job is holding API keys, image integrity matters.
- Fix: pin base image by digest, add version tags, enable BuildKit provenance/SBOM + sign with cosign in the Actions workflow.

### LOW

**L1. Upstream response headers overwrite locally-set security headers** - `returnUpstream` passes Google's headers straight through (minus hop-by-hop ones, server.js:298-304); any same-named header from upstream replaces our hardened value. Filter to an allowlist instead.

**L2. Model name decoded after path regex** - `decodeURIComponent` runs after matching `[^/:]+` (server.js:183-186), so `%2F` can produce slashes/`..` segments forwarded upstream. Host is fixed, so impact is negligible today, but validate the decoded name against `^[A-Za-z0-9._-]+$`.

**L3. Malformed JSON on PATCH admin routes throws unhandled 500s** - e.g., server.js:468 parses without try/catch (other routes do catch). Robustness only.

**L4. `/login` fallback crashes when no admin exists** - server.js:446 calls `.get().username` on an empty result -> uncaught TypeError -> 500 noise during the pre-setup window. Harmless but sloppy.

**L5. No audit logging** - admin actions (add/delete Gemini keys, generate/revoke client keys) leave no trace; the `requests` table records only successful proxy traffic. Incident investigation is impossible after a compromise.

**L6. `/health` unauthenticated** - reveals existence only (`{ok:true}`); acceptable, listed for completeness.

**L7. Login form has no CSRF token** - login CSRF is theoretically possible (attacker auto-submits their own credentials into the victim's browser). With a single-admin model the practical impact is nil. SameSite=Strict on cookies does not prevent cross-site form POSTs.

**L8. Container hardening gaps** - compose lacks `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`, `read_only` rootfs, resource limits. entrypoint needs root briefly for chown, which is exactly why no-new-privileges + explicit caps matter.

---

## 5. Priority fix list (if you want the strongest realistic posture)

1. Bind compose port to loopback: `"127.0.0.1:18765:18765"` (H1) - one-line change, removes the biggest hole.
2. Setup token requirement + atomic setup insert (H2).
3. Trusted-proxy aware rate limiting with a global bucket + map cleanup (H3).
4. Async scrypt + rate limit before hashing (M2).
5. Document mandatory proxy config: send `X-Forwarded-Proto`, add HSTS, only expose 80/443 (M3).
6. Add /logout (M6), container resource limits + cap_drop (L8/M7), digest-pin and sign images (M8).

## 6. Bottom line

- Is the code free of classic web vulns? Mostly yes: no SQLi, no stored XSS found, CSRF covered, good crypto choices, correct authz ordering.
- Does HTTPS make it "100% secure"? **No.** HTTPS is one layer. The current defaults still ship an open plain-HTTP listener (H1), a claimable setup page (H2), and rate limiting that fails under real network topologies (H3). Secrets remain plaintext at rest (M1) and the supply chain is unpinned (M8).
- Realistic rating today: **reasonable for a trusted-LAN tool; NOT yet hardened enough to call secure on a public endpoint**, even with HTTPS in front. Apply the priority list above before exposing it publicly.
