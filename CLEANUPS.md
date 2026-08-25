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
