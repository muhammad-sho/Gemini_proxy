# Cleanup Ledger

Running record of every deprecated, removed, or changed piece of code/file,
with the reason. Newest first. Referenced IDs (A1, B1, …) point at the
workstreams in `proposed-plan.md`.

## Wave 1 — P0 correctness (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 1 | `src/infrastructure/db/repositories/modelGroups.ts` | Added `removeCredentialTargets(credentialId)` + prepared statement | — | A1: deleting a credential used to leave ghost pairs inside groups |
| 2 | `src/infrastructure/db/repositories/clientKeys.ts` | Added `renameGroupRef(from,to)` / `removeGroupRef(name)` backed by private `rewriteGroups` transaction helper | — | A1: renaming/deleting a group used to leave dangling names in `client_keys.allowed_groups` |
| 3 | `src/http/routes/admin.routes.ts` | `DELETE /provider-credentials/:id` is now a two-step transaction (delete + pair cascade) after a `findById` precheck; group `PUT` cascades renames into client keys; group `DELETE` strips references **before** deleting | Old single-statement delete paths | A1: referential integrity on deletes/renames |
| 4 | `src/application/gateway/routing.service.ts` | No-capable-credential response now emits `{ error: { code: 503, message, requestId } }` | **Deprecated:** bare-string body `{ error: "…" }` on this path | A2: every proxy-origin error must use the normalized envelope (README contract) |
| 5 | `src/infrastructure/db/repositories/usageEvents.ts` | Added `prune(maxEntries)` (+ statement) mirroring request-log pruning | — | B1: `usage_events` previously grew without bound |
| 6 | `src/application/gateway/routing.service.ts` | `recordUsage()` prunes usage events with `settings.maxLogEntries` after each insert | Insert-only behavior (unbounded table) | B1: retention cap shared with request logs |
| 7 | `web/src/features/logs/LogsPage.tsx` | `load()` gained catch → error toast; monotonic request sequence guards out-of-order responses; 300 ms search debounce resets offset; `openDetail()` toasts instead of silently swallowing | **Deprecated:** try/finally-without-catch pattern; silent `catch { setDetail(null) }`; per-keystroke fetching | A3/A4: no more unhandled rejections, stale renders, or invisible failures |
| 8 | `web/src/features/settings/SettingsPage.tsx` | `maxLogEntries` hint updated to cover usage events too | Old copy mentioning only request logs | B1 follow-through: the setting now governs both tables |
| 9 | `src/__tests__/gateway.int.test.ts` | New test: rename/delete cascades + orphaned-group 503 envelope shape | — | Regression coverage for A1/A2 |
| 10 | `src/infrastructure/db/repositories/usageEvents.test.ts` | New unit suite for retention pruning (12 inserted → 10 kept, oldest dropped; no-op under cap) | — | B1 coverage |

### Deliberately NOT changed this wave

* `usage_events.provider_id` history rows of deleted credentials are kept — they are historical metrics, not live references.
* Session sliding renewal, keyboard accessibility, CSP tightening: scheduled for Waves 2–3 (see roadmap), not bundled here to keep the diff reviewable.

## Wave 2 — honest metrics & UX (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 11 | `src/infrastructure/db/repositories/usageEvents.ts` | Added `aggregateByModel(sinceSec)` (SQL SUM/COUNT over window, uses existing index) | — | B2: overview numbers were computed from the last 500 rows in JS |
| 12 | `src/http/routes/admin.routes.ts` | New `GET /api/admin/v1/usage-summary?days=1\|7`; `/state` no longer returns usage | **Deprecated:** `usageByModel` on `/state` (last-500 approximation) | B2: honest, window-scoped metrics |
| 13 | `web/src/api/client.ts` + `OverviewPage.tsx` | `UsageSummary` type + `getUsageSummary()`; Overview has Today/7-days toggle, token columns, cooling countdowns | **Deprecated:** `usageByModel` field in `AdminState`, bar-pill pseudo visualization | B2/C6 |
| 14 | `src/application/gateway/routing.service.ts` | Success path parses Gemini-shaped body and records prompt/completion tokens via new exported `extractUsageTokens()`; `recordUsage()` stores them | **Deprecated:** always-null `request_tokens/response_tokens` | B3: real token accounting (native + translated upstreams) |
| 15 | `src/infrastructure/db/repositories/adminSessions.ts` + `auth.routes.ts` (`requireAdmin`) + `adminSessionService.renew` | Sliding renewal: sessions past half-TTL extend to a fresh 24 h on admin activity | Fixed-expiry-only sessions (daily forced logouts) | C1 |
| 16 | `web/src/auth/useAuth.tsx` | 401 handler toasts "Session expired" only when previously signed in (wrong-password 401 stays silent) | Blanket authed=false flip with no feedback | C1 |
| 17 | `web/src/components/Modal.tsx` | Focus trap (Tab cycling), initial focus into dialog, focus restore on close, dialog tabIndex | Focus-free modal | C2 accessibility |
| 18 | `web/src/features/logs/LogsPage.tsx` + `App.tsx` tabs | Log rows keyboard-operable (tabIndex/role/Enter/Space); tab bar gets roving tabindex + ArrowLeft/Right navigation | Mouse-only rows/tabs | C2 |
| 19 | `web/src/features/settings/SettingsPage.tsx` | Numeric inputs clamp to zod bounds on change (NaN ignored) | Raw Number() passthrough | C3 |
| 20 | `web/src/features/groups/GroupsPage.tsx` | Stale-pair detection (credential no longer selects the model) flagged inline and auto-removed on save with count toast | Silent routing-nowhere pairs | C3 |
| 21 | `ProviderCredentialsPage.tsx` + `ClientKeysPage.tsx` | Empty states gained explanatory copy + primary action button | Plain hint text | C4 |
| 22 | `src/domain/providers/adapter.ts` | `GenerateRequest` fully typed (ContentPart/GenerateContent/GenerationConfig); `any[]` fields → typed/unknown | **Deprecated:** `contents: any[]; generationConfig?: any; safetySettings?: any[]; tools?: any` | G1 type hygiene |
| 23 | `clientKeys.ts` / `providerCredentials.ts` repos | Explicit row mappers (`Record<string, unknown>` → typed models) replacing spread-of-`any` rows | `parseRow(row: any)` pattern | G1 |
| 24 | `routing.service.ts` / `admin.routes.ts` catch blocks | `catch (err: any)` → `catch (err)` + local `errMessage(err)` helpers; logs outcome param narrowed via `isOutcome()` guard | `err?.message ?? err` chains, `q.outcome as any` | G1 |
| 25 | `gateway.int.test.ts` + `openai.protocol.test.ts` | Typed `json<T>()` helper, Cookie/ClientKeyRow/GroupRow shapes, GenerateResponse-typed fixtures | All `(x: any)` casts (18+5 removed) | G1 |
| 26 | `package.json` | `lint` script now runs `eslint src --max-warnings=0` | Warning-tolerant lint | G1 CI gate |
| 27 | `providerCredentials.ts` regression fix during this wave | Restored `seq` (rowid) on `findAllWithKeys` after the typed mapper dropped it — deterministic oldest-first key ordering preserved | Untyped spread that incidentally carried `seq` | Caught by cooldown tests; documented per ledger policy |

### Deliberately NOT changed this wave
* Streaming/countTokens remain deferred (roadmap D1/D2).
* Per-client-key rate-limit buckets land with E2 (Wave 3).

## Wave 3 — hardening (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 28 | `src/application/gateway/providerProbe.service.ts` | New `assertNotMetadataTarget()` — probe refuses cloud-metadata/link-local hosts (`169.254.*`, `fe80:*`, `*.metadata.*`, `*.internal`); LAN/loopback upstreams stay allowed | Unguarded arbitrary-URL probing | A5 (scoped: self-hosted LAN upstreams are legitimate, so RFC1918 is *not* blocked) |
| 29 | `gemini.adapter.ts` / `openai-compatible.adapter.ts` + `constants.MAX_LIST_RESPONSE_BYTES` | Model-list responses read as text and rejected beyond 2 MB before JSON parse | Unbounded `response.json()` | A5 |
| 30 | `connection.ts` | `runMigrations(db, upTo?)` applies a prefix and returns the schema version; `migrations` array moved to module scope (was function-local) | Old void-returning single-mode signature | A6 fixture support |
| 31 | `migration.test.ts` (new) | Legacy-database fixture: builds schema at `total-3`, seeds old-shape rows, completes upgrade in place, asserts data survives + new columns default NULL; runs in CI via vitest | — | A6 |
| 32 | `server.ts` helmet + `GroupsPage/ClientKeysPage/ProviderCredentialsPage/global.css` | CSP drops `'unsafe-inline'` from styleSrc; the last inline styles moved to classes (`.row-stale`, `.hint-first`) | **Deprecated:** `styleSrc 'unsafe-inline'`; inline `style={{}}` usage | E1 |
| 33 | `auth.routes.ts` | Dedicated brute-force bucket on `/login` + `/setup`: max 10/min per IP under isolated key `auth:<ip>` (shared global limiter untouched) | Credential attempts sharing the general 300/min bucket | E2 |
| 34 | `auth.routes.ts` | Over HTTPS cookies upgrade to `__Host-gemini_admin_session` / `__Host-gemini_csrf`; session reads accept both names; logout clears both variants | Plain-name cookies on secure deployments | E3 |
| 35 | env plumbing (`validation/types/config`) + `server.ts` helmet + README/compose | `HSTS=true` opt-in enables Strict-Transport-Security; **default now off** (helmet previously always sent HSTS, even over plain HTTP) | Always-on HSTS header | E3 |
| 36 | `gateway.int.test.ts` | New cases: HTTPS login yields `__Host-` cookies + authenticates; HSTS header absent by default; 12 wrong logins hit 429; suite enables `TRUST_PROXY` to exercise forwarded-proto paths | — | E2/E3 coverage |

E2 remainder deferred: admin-tunable global rate limit and per-client-key gateway buckets.

## Wave 4 — visibility, polish, quality gates (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 37 | `auditLogs.ts` + `admin.routes.ts` (`GET /audit-logs`) + `client.ts` + `SettingsPage.tsx` | Security log: filtered audit trail with action dropdown, surfaced under Settings | Audit data written but invisible | B4 |
| 38 | `ConfirmButton.tsx` (+ three pages) | `warning` prop renders consequence hints (aria-label + title) on destructive confirms | Generic bare "Delete" prompts | C5 |
| 39 | `LogsPage.tsx` / `OverviewPage.tsx` / `ClientKeysPage.tsx` | Relative log timestamps with full-time tooltips; cooling countdowns (W2); outcome filter chips; per-key "Copy ID" button | Clock-style time cell; outcome `<select>` | C6 |
| 40 | `scripts/e2e.mjs` (new) + `package.json` (`npm run e2e`) + CI step | Dependency-free end-to-end happy path (setup → provider probe → group → client key → both gateways → metrics/logs/audit) replacing a Playwright dependency — keeps the install lightweight | Playwright plan (deviation documented in roadmap) | G3 |
| 41 | `vitest.config.ts` | Coverage scoped to real source (tests/config excluded) with floors: statements/lines ≥80, functions ≥70, branches ≥65 — currently 85.2/88.3/75.4 | Unscoped coverage report (60.8% including test files) | G4 |
| 42 | New tests: `adapters.test.ts`, `providerProbe.service.test.ts`, `migration.test.ts`, `encryptionKey.test.ts`, health/audit integration case | Adapter translation/listing/pagination-cap coverage, metadata-host guard, legacy-DB upgrade fixture, key generation persistence | — | G4 support |
| 43 | `.github/workflows/ci.yml` | Test step runs with `--coverage` so the floors gate every push; e2e step added after build smoke | Coverage-blind CI | G4/G3 |
| 44 | `README.md` | Mermaid sequence diagram of a routed request; compact API reference tables for both gateways and the admin surface | Stale narrative-only docs | H1/H2 |

### Deferred from this wave
* **G2** frontend component tests (Testing Library) — next wave.
* **H3** screenshots — needs a browser environment.
* **E2 remainder** global/per-client-key rate-limit knobs.

## Wave 5 — frontend test suite + rate-limit knobs (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 45 | `web/src/lib/relTime.ts` (new) + `LogsPage/SettingsPage` | Shared relative-time helper extracted and unit-tested (`relTime.test.ts`) | Two duplicated inline `relTime` copies | G2 support / DRY |
| 46 | devDependencies: `jsdom`, `@testing-library/react`, `@testing-library/dom` (RTL v16 requires dom as explicit peer — install with `--legacy-peer-deps` per repo convention) + vitest config picks up `web/src/**/*.test.tsx` (jsdom via docblock) | Frontend component testing now possible in the existing Vitest runner | — | G2 |
| 47 | New suites: `Modal.test.tsx` (title/Escape/backdrop/focus-trap/restore), `ConfirmButton.test.tsx` (arm→confirm/cancel/warning-aria/error-toast via `act`), `SettingsPage.test.tsx` (clamp-to-bounds, garbage ignored, save payload) | First dashboard component coverage; Modal focus-trap visibility filter made layout-API-free so it works in jsdom too | — | G2/C2/C3 |
| 48 | `settingsService.ts` + `clientAccess.enforceClientKeyRate` + `domain/routing/clientKeyRateLimit.ts` (new) + both gateway routes + `server.ts` + Settings UI | E2 remainder: `rateLimitPerMinute` (global cap snapshot at boot) and `clientKeyRatePerMinute` fixed-window limiter per client key (0 = off), enforced on all four gateway handlers with a 429 envelope | Static hardcoded 300/min-only limiting | E2 |
| 49 | `gateway.int`/unit suites extended: limiter windows/independence/disabled-mode cases | — | — | Coverage for #48 |

### Notes
* React 19 + RTL defers settled-state flushes for async handlers unless wrapped in `await act(async () => …)` — the ConfirmButton error-path test asserts the toast and documents this quirk instead of asserting the deferred re-render DOM.

## Wave 6 — countTokens + full leftover sweep (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 50 | `gateway.routes.ts` (+ mock, integration tests) | `:countTokens` is now proxied through **native Gemini credentials only** — candidate scope intersected with Gemini providers before routing; unsupported actions (`streamGenerateContent`, …) keep returning a clear 404 | Strict generateContent-only rejection message | D2 |
| 51 | `settingsService.ts` schema/defaults, `client.ts` type, `SettingsPage` field, settings tests | Removed the stale `modelsCacheTtlHours` knob end-to-end (the cache it tuned was deleted when model lists became derived) | **Deprecated:** `modelsCacheTtlHours` setting (stored blobs containing it are ignored on load) | Leftover of the pair-routing redesign |
| 52 | `authService.ts`, `settingsService.ts`, `client.ts`, `constants.ts`, `openai-compatible.adapter.ts` | Dead-code purge: `changePassword` (+ its unused statement), `resetToDefaultsForTests`, `client.listGroups`, `LOG_SECRET_MASK` constant, and the `void path` workaround in `buildUrl` (renamed to `_path`) | All listed members | Leftover sweep |
| 53 | `README.md` | Corrected stale wording: model discovery is derived from selected models (no cache), documented `countTokens` support and honest streaming rejection behavior | "served from a local cache" claim | Docs accuracy |

### Still open (unchanged)
* D1 true streaming (needs focused design work), H3 screenshots (browser env), G2 remainder none.

## Project-wide cleanup pass (this change)

| # | File | Change | Deprecated / removed | Why |
|---|------|--------|----------------------|-----|
| 54 | `.prettierrc`, `package.json` | Prettier removed entirely | `.prettierrc`, `prettier` devDependency, `format` script | Dead tooling: config existed but nothing ever ran it (CI/quality handled by ESLint) |
| 55 | `eslint.config.mjs`, `package.json`, three web files | Lint scope extended to `web/src` (was explicitly ignored); fixed the three latent findings it surfaced: unused `toast` destructure in `App.tsx`, unused `waitFor` import in ConfirmButton test, stale `react-hooks/exhaustive-deps` disable directive referencing an unconfigured rule. `scripts/**` ignored so the standalone e2e runner may use console output | **Deprecated:** blanket `web/**` lint exclusion | Full-tree quality gate |
| 56 | `src/config/env.ts` | Removed `resetConfig()` | Zero-reference export | Leftover sweep |
| 57 | `src/shared/errors.ts` (new), `routing.service.ts`, `admin.routes.ts` | `errMessage(err)` helper consolidated into shared module; duplicate local copies deleted | Two identical private helpers | DRY |
| 58 | `README.md`, `proposed-plan.md` | Staleness fixes: model-discovery bullet still claimed a local cache; dashboard feature list said "model cache"; architecture tree comment referenced the removed cache service; status-snapshot test counts refreshed | Outdated docs claims | Docs accuracy |
