# Gemini Proxy — Review & Improvement Roadmap

Status snapshot: the modular rebuild is complete and verified (105/105 tests across server,
integration and dashboard suites, `npm run check` green with zero-warning lint over both
trees, dependency-free e2e happy path, and enforced coverage floors). Three isolated surfaces (Gemini :18770, OpenAI :18771, dashboard :18765), zero-config
first-run setup, live model probing, pair-based routing groups, runtime Settings tab,
env-free deployment, single `./data` folder for backups.

This document replaces the original rebuild plan. It is the living roadmap toward an
**error-free, robust, lightweight, simple, user-friendly** app. Priorities: P0 = correctness/
robustness, P1 = user-friendliness/safety, P2 = polish/lightweight. Effort: S ≤ half day,
M ≈ a day, L = multi-day.

---

## A. Correctness & robustness (P0)

### A1. Referential integrity on deletes — M
Problem: deleting a provider credential leaves its pairs inside `model_group_pairs` (dead
targets in the Groups editor, ghosts in `resolveForModel`); deleting a group leaves its name
dangling inside `client_keys.allowed_groups` (silent broken permission); renaming a group
breaks every client key that referenced the old name.
Fix:
- Credential delete → transactionally remove its rows from `model_group_pairs`.
- Group rename → update `client_keys.allowed_groups` entries in the same transaction.
- Group delete → strip the name from all client keys' `allowed_groups`.
Files: `modelGroups.ts`, `providerCredentials.ts` (or a small `integrity.ts` in db layer),
`admin.routes.ts`. Acceptance: integration tests — delete credential → group has no ghost
pairs; rename group → client key follows; delete group → name removed from keys.

### A2. Unified proxy-origin error envelope — S
Problem: `RoutingService.route()` returns `{ error: "…" }` (bare string) for the no-capable-
credential case, while every other proxy-origin error uses
`{ error: { code, message, requestId } }`. The README promises one envelope.
Fix: emit `{ error: { code: 503, message, requestId: traceId } }`; keep upstream bodies
verbatim elsewhere. Files: `routing.service.ts`, integration assertion. Acceptance: grep finds
no bare-string envelopes; test asserts shape on both gateways.

### A3. Frontend async error handling — S
Problem: `LogsPage.load()` has try/finally without catch → non-401 failures become unhandled
rejections with stale data and no feedback; `openDetail` silently swallows errors.
Fix: add catch → toast; disable pager during load; surface detail-open errors.
Files: `LogsPage.tsx`. Acceptance: forced 500 shows toast; no console rejections.

### A4. Search debounce + request race guard — S
Problem: every keystroke in the log search fires a GET; fast typing can race and render
out-of-order results.
Fix: 300 ms debounce on `query`, abort/ignore stale responses (monotonic request id).
Acceptance: one network call per settled input.

### A5. Probe hardening — S
Problem: live model probing hits arbitrary base URLs entered by the admin (SSRF-ish surface
on an admin-only endpoint — low risk, worth tightening) and relies on the adapter's fixed
30 s timeout only.
Fix: reject `baseUrl` pointing at loopback/link-local ranges unless the deployment sets an
allow flag; cap response parsing size. Acceptance: unit test rejecting `http://127.0.0.1`,
`http://[::1]`, `http://169.254.x`.

### A6. Migration & startup guarantees (keep + codify) — S
Already good (versioned migrations, readiness gates on schema+db+encryption, CI smoke).
Add: CI step asserting an *old* database migrates cleanly (create v-current-minus-one fixture,
boot, expect ready). Acceptance: CI red on regression.

---

## B. Data lifecycle & honest metrics (P0/P1)

### B1. Usage-event retention — S
Problem: `usage_events` grows forever (only request logs are pruned).
Fix: apply `maxLogEntries` (or a dedicated setting) to `usage_events` on insert, same pattern
as request-log pruning. Acceptance: test inserting N+k keeps newest N.

### B2. Honest overview numbers — S
Problem: "Usage by model" is computed from the most recent 500 events — mislabeled and wrong
at scale.
Fix: aggregate with SQL over a chosen window (today / 7d toggle), using the
existing `(client|provider, model, created_at)` indexes. Acceptance: numbers match direct SQL.

### B3. Token accounting — S
Problem: `usage_events.request_tokens/response_tokens` are always null even though Gemini
responses carry `usageMetadata` (and the OpenAI path maps them into chat responses).
Fix: parse usageMetadata on success and store prompt/completion tokens; expose totals in
Overview. Acceptance: integration test asserts stored tokens equal mock values.

### B4. Audit log visibility — M
Problem: setup/login/logout/mutations write `audit_logs` nobody can see.
Fix: read-only admin endpoints (`GET /audit-logs` with time/action filters) + simple
dashboard section under Settings ("Security log"). Acceptance: actions taken in the UI appear
there.

---

## C. User-friendliness (P1)

### C1. Session lifetime & feedback — S
Problem: sessions expire after exactly 24 h with no warning; users get logged out mid-work.
Fix: sliding renewal (extend expiry on activity), and the existing global 401 handler already
returns users to login cleanly — add a toast "Session expired". Acceptance: active use past
24 h stays signed in.

### C2. Keyboard & modal accessibility — M
Problem: modals lack focus trap/restoration; log rows open details via bare onClick (not
keyboard reachable); tab list lacks arrow-key navigation.
Fix: shared focus-trap util in `Modal`, rows as buttons/`tabIndex` + Enter handler, arrow-key
tabs. Acceptance: full dashboard flow achievable by keyboard.

### C3. Forms that prevent mistakes — S
Problems: Settings numeric inputs accept garbage until server rejects; credential/group forms
allow saving states that route to nothing (e.g. group with pairs whose models aren't selected
on the credential anymore after an edit).
Fix: clamp/min-max inline validation mirroring the zod bounds; Groups editor warns when a
pair references a model no longer selected on its credential (offer one-click cleanup).
Acceptance: invalid input blocked client-side with message.

### C4. Guided empty states — S
Problem: first-run flow ends at an empty dashboard.
Fix: each empty page gets one-line guidance + action button (Providers → "add your first key";
Client keys → "create a key"; Groups → disabled until a credential exists, explaining why).
Acceptance: a new admin can go from zero to a working client key without docs.

### C5. Consistent destructive patterns & copy — S
Problem: ConfirmButton labels vary; deletion of entities referenced elsewhere (credential in
groups, key with traffic) gives no consequence hint.
Fix: standardize "Delete X?" prompts listing consequences ("used by 2 groups").
Acceptance: review pass over all destructive actions.

### C6. Live status niceties — S
Ideas: relative timestamps with tooltips, cooling countdown timers on Overview, copy-button
for client-key id, filter chips on Logs. Small, high perceived quality.

---

## D. Protocol completeness (P2 — feature work, explicitly deferred until core is stable)

### D1. Streaming — L
Today `streamGenerateContent`/`stream:true` either buffer whole SSE responses (Gemini ingress
forwards `alt=sse`) or get rejected (OpenAI ingress). Decide and implement properly:
Gemini→Gemini byte-passthrough streaming; OpenAI SSE translation; keep deadline/abort
semantics per-chunk. Large change to `callUpstream` (response as stream, backpressure,
size caps per chunk).

### D2. countTokens passthrough — S
Allow-list the second action for capable providers (native passthrough; translate for
openai-compatible where feasible, else clear 501).

### D3. Richer model metadata — S
Probe already receives capabilities/display names upstream-side; optionally cache names
in-memory per session for nicer pickers without persisting (respecting "never store"
rule for retrieval results).

---

## E. Security hardening (P1)

### E1. CSP without `unsafe-inline` — S
Dashboard CSS is external since the Vite build; try removing `styleSrc 'unsafe-inline'`,
verify visually, keep a nonce-based fallback if React inline styles ever need it.

### E2. Rate-limit tuning — M
Single static 300/min/IP today. Move baseline to Settings (admin-tunable), add a stricter
bucket for `/setup` + `/login` (brute-force), and consider per-client-key limits on gateway
surfaces (429 with `retry-after`). Acceptance: config knobs documented; tests for buckets.

### E3. Cookie/session headers review — S
When served over HTTPS/reverse proxy: `__Host-` cookie prefixes, HSTS opt-in env flag.
Acceptance: checklist verified behind a TLS proxy.

### E4. Dependency & image hygiene (keep green) — S
Dependabot/renovate config, `npm audit` gate (high severity), monthly base-image bump;
document better-sqlite3 toolchain pinning.

---

## F. Lightweight & performance (P2)

### F1. Query/statement audit — S
All hot paths use prepared statements ✓; verify indexes cover the new pair queries
(`idx_model_group_pairs_target` ✓) and log-search LIKE pattern (consider FTS5 later only if
search becomes slow at MAX_LOG_ENTRIES=100k).
### F2. Startup/shutdown polish — S
WAL checkpoint on graceful shutdown; log DB size + row counts at boot (debug level).
### F3. Bundle — S
65 KB gzipped dashboard is fine; defer code-splitting until >150 KB gz.
### F4. Container — S
Runtime stage already minimal alpine + pruned node_modules; add `IMAGE` size badge/check
(<200 MB uncompressed target) to CI so regressions surface.

---

## G. Quality gates (P1)

### G1. Type-clean tests — S
40 `@typescript-eslint/no-explicit-any` warnings concentrate in the integration test; add
small typed helpers (inject wrappers, cookie jar type) and enable `--max-warnings=0` in CI.

### G2. Frontend component tests — M
Vitest + Testing Library for: ModelSelector (fetch/move/remove/exclude-selected),
GroupModal (pair builder), ClientKeyModal permissions, Settings clamping, LogsPage
(error toast + pagination). No backend needed (mock api module).

### G3. One end-to-end smoke — M
Playwright (headless) against the built app: boot fresh DATA_DIR → setup → add credential
(mock upstream) → select models → create group → create client key → call both gateways →
see logs. Single happy-path test, runs in CI after build.

### G4. Coverage floors — S
Vitest coverage thresholds (lines ≥80% overall; routing/keySelection/settings ≥90%) once
G2 lands.

---

## H. Documentation (P2)

### H1. Architecture refresh — S
README tree + diagram update (three surfaces, catalog derivation, group plans, settings);
sequence diagrams for a routed request (auth → allowlist → plan → attempts → logging).
### H2. API reference — S
One compact table per surface including the new probe/groups/settings/setup endpoints with
request/response examples.
### H3. Screenshots — S
Dashboard tabs in README (Overview/Providers picker/Groups/Logs detail).

---

## Recommended execution waves

1. **Wave 1 — stop the bleeding (P0):** A1, A2, A3, B1 (+tests) — ✅ DONE. Every deprecated/changed item is logged in `CLEANUPS.md`.
2. **Wave 2 — trust the numbers & the UX:** B2, B3, C1–C4, G1 — ✅ DONE (see `CLEANUPS.md`).
3. **Wave 3 — hardening:** A4 ✅(done in W2), A5 ✅, A6 ✅, E1 ✅, E2 ✅(partial: global knob + per-key buckets deferred), E3 ✅, G2 — see `CLEANUPS.md`. 5. **Wave 5 — frontend tests + limit knobs:** G2 ✅ (Modal/ConfirmButton/Settings + relTime util), E2 ✅ (rateLimitPerMinute boot knob + clientKeyRatePerMinute live per-key buckets). 6. **Wave 6 — countTokens + leftover sweep:** D2 ✅, dead-code/stale-setting purge ✅. Remaining open: D1 streaming, H3 screenshots.
4. **Wave 4 — polish & growth:** B4, C5, C6, G3, G4, H*, F*.
5. **Later milestones (unchanged):** D1 streaming, D2 countTokens — only after Wave 3.

---

## Cleanup pass log

A project-wide cleanup pass ran after Wave 6 (see `CLEANUPS.md` entries 50–58): countTokens
milestone landed, the stale cache-TTL knob and all dead code were purged, prettier was
removed as dead tooling, and ESLint now lints both server and dashboard trees with zero
warnings enforced.

## UI refresh

The dashboard was visually rebuilt as a high-contrast technical control panel: flat
rectangular design (zero radius enforced globally), 1px borders, subtle shadows, Plus
Jakarta Sans / JetBrains Mono (self-bundled), light+dark themes with a persisted toggle,
and functional-only semantic colors. No component logic changed.