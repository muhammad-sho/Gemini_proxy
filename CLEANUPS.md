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
