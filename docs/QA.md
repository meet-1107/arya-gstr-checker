# Production QA matrix

What has and has not been tested, per scenario. **Status vocabulary:** `AUTO` = automated test that fails the build; `BROWSER` = run by hand against the real UI in the in-app browser (dev server, mock provider) — repeatable with the steps given, not part of `npm test`; `MANUAL` = needs a human on a real device/environment; `N/A` = cannot be exercised yet (the dependency does not exist). Nothing here was run against a real GST provider, real Firebase, Firestore, or a physical phone.

Run before any release: `npm run typecheck && npm run lint && npm test`, then `NEXT_DIST_DIR=.next-build npm run build && NEXT_DIST_DIR=.next-build npm run perf:bundle:check`, then `npm run preflight` with the production environment variables.

## Verification scenarios (the roadmap's QA list)

| Scenario | Status | Evidence / how |
|---|---|---|
| Malformed GSTIN (empty, length, format, checksum) | AUTO | `verification.test.ts` (local validation: no provider call, no quota), `verify-machine.test.ts` (answered client-side with the reason). |
| Valid GSTIN → ACTIVE / SUSPENDED / CANCELLED / INACTIVE / UNKNOWN | AUTO | `verification.test.ts` status mapping; `api-verify.test.ts` over HTTP. |
| "Not found" GSTIN | AUTO + BROWSER | Never cached, no quota, not called fake (`verification.test.ts`, `api-verify.test.ts`); result card with caveat seen in browser. |
| Provider timeout / maintenance / rate limited / bad response | AUTO | Classification, refund, `lastKnown`, deadline (`verification.test.ts`); breaker fail-fast; provider-health states (`verification-smart.test.ts`). |
| Provider down (circuit open) | AUTO + BROWSER | Fail-fast "service unavailable" (no provider call) asserted; seen in browser with `MOCK_TIMEOUT` (milestone 7). |
| API timeout | AUTO + BROWSER | 20 s server deadline (`verification.test.ts`); browser: request that never answers → slow banner at 5.1 s, client gives up at 25.4 s with "We couldn't verify this right now … does not mean the GSTIN is fake", button re-enabled, no console errors. |
| Slow response | BROWSER | 8 s response: "Taking longer than usual" at 5.07 s, *Keep waiting* dismisses it, result arrives. Thresholds are unit-tested (`verify-machine.test.ts`). |
| Offline | AUTO + BROWSER | Detected before any request (0 requests sent), clear message, recovers on `online` + *Try again*. |
| Slow network (2G/3G/slow 4G) | MANUAL | The in-app browser cannot throttle. Slow-*response* behaviour is covered above; `classifyNetwork` "weak" is unit-tested but depends on the Network Information API (absent in Safari/Firefox). |
| Network drop mid-request | BROWSER | `fetch` rejection → "Couldn't reach the server" with the format-valid checklist and *Try again*. |
| Server errors: 500, 502 with an HTML body, malformed JSON, 429, 402 (quota), 403 (role) | BROWSER | Each gives a specific, non-technical message; 402 offers *View plans*; the button is never left stuck; no crash or console errors. |
| Malformed or future server answer (missing `verification`, unknown `outcome`) | AUTO + BROWSER | **Bug found by this QA:** was reported as "couldn't reach the server" (and an unknown outcome would crash the render). Now `isVerificationView` guard → "The server sent an answer we couldn't read" (`production-qa.test.ts`; browser-verified). |
| Session expired (401) | BROWSER | Signs out and redirects to `/login?next=/verify`. |
| Duplicate searches / double-click / double-Enter | AUTO + BROWSER | **Bug found:** a triple click sent 3 requests (each aborting the last). Now ignored while the same request runs → 1 request. Server de-duplicates in flight (50 simultaneous → 1 provider call, `perf.test.ts`). |
| 100 repeated searches | AUTO + BROWSER | Browser: 100 clicks → 79 requests (the rest ignored while one was running), final UI correct, +20 DOM nodes, no errors. Server: `perf.test.ts`. |
| App backgrounded during a search | BROWSER (simulated) | `visibilitychange` hidden for 3 s with a request in flight → result still arrives, UI consistent. A real OS suspending the tab is MANUAL. |
| Phone locked during a search | MANUAL | A killed connection surfaces as the "couldn't reach the server" state with *Try again* (covered above); real lock/unlock behaviour not tested. |
| Battery saver / network switch (Wi-Fi ↔ mobile) | MANUAL | Not testable here. |
| Back button | BROWSER (partly) | History navigation from a result page returns to `/verify` with no crash. **Raw `history.pushState` is not how users navigate** (it confuses Next's router); a real Android back press is MANUAL. |
| Camera permission denied / camera unavailable / no BarcodeDetector | BROWSER | Milestone 8: camera is requested only after the in-dialog tap; each failure has a message and "Enter GSTIN manually"; tracks stop on close. Real camera and real QR codes: MANUAL. |
| Firebase down | N/A | Firebase auth is not configured in any environment yet (dev auth only). `/api/ready` reports a broken configuration/store as 503 (`production-qa.test.ts`). |
| Real provider behaviour | N/A | No real provider adapter exists. |

## Whole-app checks

| Check | Status | Evidence |
|---|---|---|
| Every API route rejects anonymous callers (all 62 route files, every exported method) | AUTO | `production-qa.test.ts` enumerates `src/app/api/**/route.ts`: 401, except documented public routes (`/api/health`, `/api/ready` → 200; scheduler hook `/api/internal/portfolio-due` → 404 without its secret). A new route that forgets authentication fails the build. Responses never contain stack traces or secret names. |
| Every page renders (32 page routes) | BROWSER/HTTP | `GET` each page: 200, no "Application error". |
| Error pages | AUTO + BROWSER | **Gap found:** no `error.tsx`, `global-error.tsx` or `not-found.tsx` (production would show Next's bare screens). Added; they never render the error message or stack (`production-qa.test.ts`); 404 page seen in browser. |
| Health / readiness | AUTO + live | `/api/health` (liveness) and `/api/ready` (config + one store read; 503 names only the failing check, never the reason). |
| Security headers | AUTO + live | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (camera allowed for our origin only), `Cross-Origin-Opener-Policy: same-origin-allow-popups`, HSTS (production only), `X-Powered-By` removed, **CSP in report-only mode**. Verified on a live response; asserted in tests. |
| Production configuration | AUTO | `npm run preflight` (`src/config/preflight.ts`): refuses dev auth/memory store/mock provider/scenario switches, missing or mismatched Firebase config, half-set service accounts, malformed numbers, weak scheduler secret; never prints secret values. |
| Env var documentation | AUTO | Every variable read by the server must appear in `.env.example` (the test found 26 undocumented ones; documented). |
| No server secret reachable from browser code | AUTO | Browser files may read only `NEXT_PUBLIC_*` / `NODE_ENV`. |
| Accessibility (axe) | BROWSER | Per milestone, both themes, 1280 and 390 px (see README). |
| Bundle size budgets | AUTO (CLI) | `npm run perf:bundle:check` against `config/performance.json`. |

## Known gaps and what would close them
- **No end-to-end suite.** Playwright (`@playwright/test`, `@axe-core/playwright`, Chromium) needs your approval to install; until then the BROWSER rows above are manual and the harness is a script pasted into the page.
- **CSP is report-only** until checked against a real Firebase sign-in and tightened (nonces instead of `'unsafe-inline'`).
- **Real-device, throttled-network, locked-phone, iOS Safari/Firefox, screen-reader and high-contrast testing** — none done.
- **Firestore, Firebase Auth, a real GST provider, billing, email, durable queue, deployment** — not integrated, so not QA'd. `npm run preflight` fails on purpose until real values exist.
- **Dev-server flakiness:** during this QA the shared dev server crashed once with a Turbopack internal panic (a Next.js bug, not application code) and was restarted several times by parallel sessions; one run of one test timed out under that load.
