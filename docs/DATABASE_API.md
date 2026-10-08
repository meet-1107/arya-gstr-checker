# GST CA Platform — DATABASE_API.md

## 1. Database recommendation

### Primary database: Firebase Cloud Firestore

Firestore is appropriate for the MVP because the application is naturally document-oriented and multi-tenant.

Firebase provides no-cost quotas for Firestore and then usage-based billing on the Blaze plan. Current Firestore documentation lists a free quota of 1 GiB stored data, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day and 10 GiB/month outbound transfer for the qualifying database. citeturn1search0turn1search1

Cloud Functions require the Blaze plan. Cloud Storage for Firebase also requires Blaze. citeturn1search4turn1search8

### Firestore production collections

```text
organizations/{organizationId}
users/{userId}
organizations/{organizationId}/members/{userId}
organizations/{organizationId}/clients/{clientId}
organizations/{organizationId}/gstins/{gstinId}
organizations/{organizationId}/checks/{checkId}
organizations/{organizationId}/imports/{importId}
organizations/{organizationId}/jobs/{jobId}
organizations/{organizationId}/usage/{period}
organizations/{organizationId}/subscriptions/{subscriptionId}
organizations/{organizationId}/alerts/{alertId}
organizations/{organizationId}/auditLogs/{auditId}
```

## 2. Core data model

### Organization

```json
{
  "name": "ABC CA Firm",
  "ownerId": "uid",
  "planId": "professional",
  "status": "active",
  "createdAt": "timestamp"
}
```

### Client

```json
{
  "name": "ABC Industries Pvt Ltd",
  "gstins": ["24AAAAA0000A1Z5"],
  "email": "client@example.com",
  "phone": "9876543210",
  "assignedTo": "uid",
  "status": "active"
}
```

### GSTIN

```json
{
  "gstin": "24AAAAA0000A1Z5",
  "clientId": "client_123",
  "legalName": "ABC Industries Pvt Ltd",
  "tradeName": "ABC Industries",
  "status": "Active",
  "taxpayerType": "Regular",
  "state": "Gujarat",
  "lastCheckedAt": "timestamp",
  "source": "gstinapi",
  "cacheExpiresAt": "timestamp"
}
```

### Return history

```json
{
  "gstinId": "gst_123",
  "financialYear": "2026-27",
  "period": "082026",
  "returnType": "GSTR3B",
  "status": "FILED",
  "filingDate": "timestamp",
  "arn": "ARN...",
  "source": "gst_provider"
}
```

## 3. Important database rules

- Tenant ID must be derived from authenticated identity, not supplied blindly by client.
- Never allow a CA user to read another organization's documents.
- Store only necessary GST/customer data.
- Keep provider response snapshots only where legally/business-wise necessary.
- Store `source`, `checkedAt`, `providerRequestId`, and `cacheExpiresAt`.
- Keep audit logs for administrative actions.
- Use composite indexes only for actual dashboard queries.
- Avoid large Firestore documents. Put large CSVs/reports in Cloud Storage.

## 4. Firebase cost planning

Firebase has two main plans:

- Spark: no-cost plan with no payment information required.
- Blaze: pay-as-you-go and required for services such as Cloud Functions and expanded usage. citeturn1search1

For this application, production should be designed for **Blaze**, because bulk GST processing needs background workers and Cloud Storage.

Firestore Standard pricing is usage based. Firebase documentation currently shows, for the standard model in a common region, approximately:

- Reads: $0.30 per 1 million
- Writes: $0.90 per 1 million
- Deletes: $0.10 per 1 million

Exact pricing depends on database region and Google Cloud pricing. citeturn1search2

### Practical early-stage estimate

For a small CA SaaS with:
- 100 CAs
- 20 clients/CA
- 2,000 clients
- moderate dashboard usage
- 20,000–100,000 Firestore operations/day

Firestore itself should generally be a relatively small portion of the total infrastructure bill. The GST API cost is likely to be more important than Firestore at meaningful GST-check volumes.

Do not hard-code a monthly Firebase cost into the business model. Monitor actual reads/writes/storage and set Google Cloud budget alerts. Firebase explicitly recommends budget alerts on Blaze. citeturn1search1

## 5. GST API options

### Option A — GSTIN API

Current published pricing:

| Pack | Price | Credits | Effective cost |
|---|---:|---:|---:|
| Free | ₹0 | up to 100 | ₹0 |
| Starter | ₹199 | 250 | ₹0.80/check |
| Growth | ₹599 | 1,200 | ₹0.50/check |
| Scale | ₹2,499 | 6,250 | ₹0.40/check |
| Custom | Quote | 25,000+ | negotiable |

Credits reportedly do not expire. The published API limit is 60 requests/minute. citeturn0search3turn0search5turn0search15

Its published API includes GSTIN verification and return filing history/compliance information. citeturn0search1turn0search3

### Option B — WhiteBooks

WhiteBooks publishes a GST API based on a direct GSP-licensed connection and documents GSTIN validation, GSTR-1, GSTR-3B, GSTR-9, GSTR-2A/2B and other GST functionality. Its documentation currently lists 281 GST endpoints. citeturn0search0turn0search4

Use this type of provider if the roadmap requires more than verification/filing-history checks, especially future filing, reconciliation, 2A/2B or e-invoice workflows.

**Pricing:** request a commercial quote before selecting it. Do not assume a public per-call price.

### Option C — GSTVerify / GSTIN.cloud

Current public pricing includes:

- Pro: ₹299/month
- Business: ₹999/month
- Business includes 1,000 API calls/month
- Developer API also has pay-as-you-go pricing published separately.

The provider markets bulk GSTIN operations, watchlists and webhooks. citeturn0search9

### Recommendation

For MVP:

**Use a simple GST verification + filing-history API first.**

For a larger CA platform:

**Keep a provider adapter and evaluate a GSP-backed provider such as WhiteBooks for deeper GST workflows.**

Do not build the product around one vendor's API schema.

## 6. API abstraction

```text
Your App
   ↓
GSTProviderService
   ↓
Provider Adapter
   ├── GSTIN API
   ├── WhiteBooks
   └── Future Provider
```

Example:

```ts
interface GstProvider {
  verifyGstin(gstin: string): Promise<GstinVerification>;
  getReturns(
    gstin: string,
    financialYear: string
  ): Promise<ReturnHistory>;
}
```

## 7. GST API cost model

If a provider charges ₹0.40 per GSTIN check:

| Monthly checks | API cost |
|---:|---:|
| 1,000 | ₹400 |
| 5,000 | ₹2,000 |
| 10,000 | ₹4,000 |
| 25,000 | ₹10,000 |
| 50,000 | ₹20,000 |
| 100,000 | ₹40,000 |

Add GST/taxes and provider-specific commercial terms where applicable.

This is the **raw API cost**, not your customer-facing price.

## 8. Usage accounting

Track:

```text
plan_limit
used_this_month
remaining
api_calls
successful_checks
cached_checks
failed_requests
provider_cost
```

Recommended rule:

> A cached result should not consume a paid GST check if the product can satisfy the request without contacting the provider.

This can materially improve margins.

## 9. Subscription economics

Example Professional plan:

```text
Customer price: ₹999/month
Included checks: 2,500
Maximum theoretical provider cost:
2,500 × ₹0.40 = ₹1,000
```

That plan would have poor economics if every included check causes a paid provider call at ₹0.40.

Therefore, either:

1. negotiate lower API pricing at volume,
2. include fewer checks,
3. charge overage,
4. cache aggressively,
5. or use a blended API provider strategy.

This is one of the most important commercial constraints in the product.

## 10. Better pricing structure

Use:

```text
Subscription fee
+
Included GST checks
+
Optional overage
```

Example:

```text
Professional
₹999/month
2,000 GST checks included
₹0.60 per additional check
```

The exact numbers should be validated against your selected provider's negotiated cost.

## 11. API rate-limit architecture

```text
CSV upload
   ↓
Import batch
   ↓
Job queue
   ↓
Subscription check
   ↓
Tenant monthly quota check
   ↓
Provider rate limiter
   ↓
GST API
   ↓
Cache
   ↓
Firestore
```

Never process a 5,000-GSTIN CSV with a simple `Promise.all()`.

Use a queue with concurrency control.

## 12. Data retention

Recommended defaults:

| Data | Retention |
|---|---|
| Client master | Until deleted |
| GSTIN profile | Until client deleted |
| Filing history | 3–7 years configurable |
| API raw response | Short period unless required |
| CSV original | 30–90 days |
| Audit logs | 1–3+ years depending on requirements |
| Generated reports | 30–180 days |

Retention must ultimately be aligned with legal/accounting requirements and your privacy policy.

---

## Implementation notes (as built — 2026-10-06)

Source of truth for code: `src/lib/store/types.ts` (interface), `memory.ts` (dev/test), `firestore.ts` (production, **unverified against live Firestore**).

```text
organizations/{orgId}                    org + embedded subscription (plan, subscriptionStatus, billingPeriod, trialEndsAt, currentPeriodEnd)
organizations/{orgId}/members/{uid}      role, email, name, addedAt, lastActiveAt
organizations/{orgId}/clients/{id}       (+ nameLower for prefix search)
organizations/{orgId}/gstins/{gstin}     latest verification = the cache (cacheExpiresAt)
organizations/{orgId}/returns/{gstin}    { records: ReturnRecord[] }
organizations/{orgId}/checks|alerts|auditLogs/{id}
organizations/{orgId}/usage/{YYYY-MM}    used, cachedChecks, failedRequests  (transactional reserve)
users/{uid}                              profile
users/{uid}/memberships/{orgId}          mirror of membership → lists a user's orgs without a collection-group index
invitations/{sha256(token)}              keyed by token hash; token itself is never stored
```

Rules: the subscription is owned by the **organization**; usage/seats/clients are org-wide. All access is server-side (API → service → store); Firestore security rules must deny all direct client access (rules + tests: ⚠️ BLOCKED, no Java for emulator).

### HTTP API (all responses `{success, data}` | `{success:false, error:{code,message}}`)
Auth: `Authorization: Bearer <Firebase ID token>`. Tenant: optional `X-Organization-Id` selector, verified against membership (required if the user has >1 org).

| Method | Path | Notes |
|---|---|---|
| GET | /api/me | identity + organizations |
| GET, POST | /api/organizations | list / create (verified email; paid plan = 14-day trial) |
| GET | /api/subscription, /api/usage | active org's subscription / shared usage |
| GET, POST | /api/members | list (team:manage) / invite → one-time token |
| PATCH, DELETE | /api/members/{uid} | change role / remove |
| POST | /api/members/transfer-ownership | owner only |
| POST | /api/invitations/accept | verified email must match invite |
| DELETE | /api/invitations/{id} | revoke |
| GET, POST | /api/clients | paginated list (`limit`,`cursor`,`q`) / create |
| GET, PATCH, DELETE | /api/clients/{id} | |
| POST | /api/gst/check | `{clientId, force?}` |

Planned, not built: bulk-check, imports, gstins/{gstin}[/returns], reports, alerts, billing, audit-logs, search.

---

## Implementation notes — milestone 3 (product query + bulk layer, 2026-10-06)

### New / changed data (see `src/lib/store/types.ts`)
```text
organizations/{orgId}/gstins/{gstin}      + clientName, clientNameLower, assignedTo, checked(bool),
                                            indicator, gstr1Missing, gstr1Late, gstr3bMissing, gstr3bLate, lastReturnsAt
                                            → every dashboard count / list filter is an indexed single-field query
organizations/{orgId}/returns/{gstin}_{TYPE}_{YYYYMM}   one doc per return (NormalizedReturn); replaces the old single doc
organizations/{orgId}/jobs/{jobId}                      BulkJob (counts + quota accounting; mutated only via atomic store ops)
organizations/{orgId}/jobs/{jobId}/items/{itemId}       BulkJobItem (status, attempts, held, settled)
organizations/{orgId}/idempotency/{key}                 {jobId, fingerprint, createdAt}   key = k:sha256(header) | auto:fingerprint
organizations/{orgId}/usage/{YYYY-MM}                   + reserved   (remaining = limit − used − reserved)
```
NormalizedReturn: `id, gstin, clientId, returnType, financialYear, period(MMYYYY), periodSort(YYYYMM), status(FILED|NOT_FILED|UNKNOWN), state(FILED_ON_TIME|FILED_LATE|NOT_FILED|PENDING|UNKNOWN), filingDate, dueDate, delayDays, arn, source, checkedAt, retrievedAt`.
`state` is computed when history is retrieved (as of `retrievedAt`).

### Indexes
Equality-only filters (+ `__name__` order) need no composite index. **Not yet generated** (⚠️ unverified, to be taken from emulator/Firestore error output): sort by `lastCheckedAt` with filters; `refreshBefore` (range on `cacheExpiresAt`) combined with other filters; return date-range queries (`dueDate` / `filingDate`) with equality filters; job items `(status, claimedAt)`.

### New endpoints
| Method | Path | Notes |
|---|---|---|
| GET | /api/dashboard | indexed counts + recent checks/activity + plan/quota; no provider calls |
| GET | /api/gstins | `q status indicator assignedTo checked needsRefresh gstr1 gstr3b late sort(gstin\|lastCheckedAt) dir limit cursor` |
| GET | /api/gstins/{gstin} | record + client + freshness |
| GET | /api/gstins/{gstin}/status | lightweight status (Unknown ≠ inactive) |
| GET | /api/gstins/{gstin}/returns | `returnType fy period status state dueFrom dueTo filedFrom filedTo dir limit cursor` |
| GET | /api/returns/gstr1, /api/returns/gstr3b | org-wide, same filters + `gstin`; rows carry `clientName` |
| POST | /api/bulk-checks/preview | `{clientIds \| mode, force?, includeReturns?}` → quota + time estimate (consumes nothing) |
| POST | /api/bulk-checks | start job. Header `Idempotency-Key`. **202** new / **200** replay. Errors: 402 QUOTA_EXHAUSTED, 403 FEATURE_NOT_AVAILABLE, 409 IDEMPOTENCY_IN_PROGRESS, 422 IDEMPOTENCY_KEY_REUSED |
| GET | /api/bulk-checks, /api/bulk-checks/{id}, /api/bulk-checks/{id}/items | progress, counts, quota accounting, per-GSTIN results (error **codes** only) |
| POST | /api/bulk-checks/{id}/cancel \| retry-failed \| resume | `checks:run` roles; cross-org ids → 404 JOB_NOT_FOUND |

Selection `mode`: `all`, `never_checked`, `needs_refresh`, `needs_attention` (resolved from stored data, max 10,000 per job).
Job statuses: `queued → running → completed | completed_with_errors | failed | cancelled`.

---

## Implementation notes — milestone 4 (2026-10-06)

- `Store.deleteGstinData(orgId, gstin)` — removes the GSTIN record and all its stored returns. `ClientService.remove` calls it, so deleting a client leaves no orphaned rows or inflated dashboard counts. (Firestore: deletes `organizations/{org}/gstins/{gstin}` and every `returns` doc where `gstin == …`.)
- No new endpoints this milestone. The frontend consumes the existing API; response types are derived (type-only) from the server services in `src/lib/client/types.ts`, so they cannot drift.

---

## Implementation notes — milestone 5: CSV import (2026-10-06)

### Data
```text
organizations/{orgId}/imports/{importId}              ImportRecord: status, counts, toCreate/processed, chunks/nextChunk,
                                                      verify {requested, includeReturns, allowPartial, jobId?, errorCode?},
                                                      failedRows (first 1,000) + failedRowsTruncated, fingerprint
organizations/{orgId}/imports/{importId}/chunks/{n}   { rows: ImportRowData[] }  (≈500 validated rows per doc; written BEFORE the record)
organizations/{orgId}/idempotency/imp:{k|auto}:{…}    shares the idempotency collection with bulk checks (namespaced keys)
```
Counters change only through `Store.incrementImport` (atomic; appends failed rows up to the cap). Client ids created by an import are deterministic (`c_` + sha256(importId:gstin)[0..24]) so re-processing a chunk can never create a duplicate.
Status: `queued → processing → completed | completed_with_errors | failed`.

### Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | /api/imports/preview | `{csv, fileName?, hasHeader?, mapping?}` → counts, mapping, samples, plan capacity, verification estimate. Stores/consumes nothing. Body ≤ 6 MB, CSV ≤ 5 MB / 20,000 rows |
| POST | /api/imports | start. `Idempotency-Key` header. Body adds `allowPartialClients`, `verify:{includeReturns, allowPartial}`. **202** new / **200** replay. Errors: 402 CLIENT_LIMIT_REACHED, 403 FORBIDDEN, 400 NO_VALID_ROWS / MAPPING_REQUIRED / EMPTY_FILE, 413 FILE_TOO_LARGE / TOO_MANY_ROWS / PAYLOAD_TOO_LARGE, 409 IDEMPOTENCY_IN_PROGRESS, 422 IDEMPOTENCY_KEY_REUSED |
| GET | /api/imports, /api/imports/{id} | history / progress (no fingerprint, no raw failed rows) |
| GET | /api/imports/{id}/failed-rows | `text/csv` attachment: `line, client_name, gstin, email, phone, reason_code, reason`; formula-safe; `X-Failed-Rows-Truncated: true` when capped |
| POST | /api/imports/{id}/resume | restart the worker from `nextChunk` |

Permissions: preview/start/resume need `imports:run` (OWNER, ADMIN, ACCOUNTANT); reads need `clients:read` (all roles). Cross-org ids → 404 IMPORT_NOT_FOUND.
Reason codes: `EMPTY, LENGTH, FORMAT, CHECKSUM, DUPLICATE_IN_FILE, ALREADY_IN_ORG, ALREADY_EXISTS, MISSING_NAME, NAME_TOO_LONG, INVALID_EMAIL, INVALID_PHONE, PLAN_LIMIT_REACHED` (texts in `src/lib/import-reasons.ts`).

---

## Implementation notes — milestone 7: GST verification engine (2026-10-06)

### Data
```text
organizations/{orgId}/verifications/{GSTIN}   VerificationRecord { gstin, outcome, details{legalName,tradeName,taxpayerType,state,registrationDate,cancellationDate},
                                              source, providerRequestId?, verifiedAt, by, requestId }   ← one doc per GSTIN per org (upsert); registry answers ONLY
```
Never written: pipeline failures (timeout, maintenance, rate limit, provider error). Used as both the verification **cache** (status outcomes only, TTL 24 h; `NOT_FOUND` is always re-asked) and the "recent verifications" list (`orderBy verifiedAt desc` — single-field index, automatic). `Store.getVerification / putVerification / listVerifications` are covered by the shared store contract (Firestore variant skipped: no emulator, **unverified**). Audit action `GST_VERIFY` (metadata: outcome, requestId).

### Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | /api/verify | `{gstin, force?}` → `{verification: VerificationView}`. `checks:run`. **Every registry answer and every classified failure is a 200 with a typed `outcome`** (`ACTIVE SUSPENDED CANCELLED INACTIVE UNKNOWN NOT_FOUND INVALID_GSTIN TIMEOUT MAINTENANCE RATE_LIMITED PROVIDER_ERROR`; `NETWORK_ERROR` is client-side only). HTTP errors only for 401/403 (auth, role), 402 `QUOTA_EXHAUSTED`, 403 `SUBSCRIPTION_INACTIVE`, 400 malformed body. |
| GET | /api/verify/recent?limit= | newest first (max 50) with `ageSeconds`. `dashboard:read` (all roles). |
| GET | /api/verify/health | process-local metrics for the active org + provider breaker state. `auditlog:read` (ADMIN/OWNER). |

`VerificationView`: `requestId, gstin, outcome, invalidReason?, formatValid, details?, source?, verifiedAt?, freshness (live|cached|none), ageSeconds?, retryable, retryAfterMs?, lastKnown? (stale prior answer, failures only), durationMs`.

### Pipeline and accounting
permission → local format+checksum validation (free, no provider call) → cache → quota reserve → provider via `ResilientProvider` under a **hard 20 s deadline** → classify → store → view. One live verification = one usage unit (same model as GST checks, 1 provider request, no return history); cache hits (`cachedChecks`), `NOT_FOUND` and non-billable failures consume none (refund). Provider `GST_PROVIDER_NOT_FOUND` (new, non-retryable, does not trip the breaker) is the "no registration" signal; real adapters must map the vendor's equivalent to it.
Dev/E2E scenarios for the mock provider (refused in production): `MOCK_NOT_FOUND`, `MOCK_TIMEOUT` (comma-separated GSTINs), `MOCK_DELAY_MS`.

---

## Implementation notes — milestone 8: verification UX (2026-10-06)
- `VerificationRecord.saved?: boolean` (organization-wide pin; preserved across live/cached re-verification and NOT_FOUND replacement). `Store.listVerifications(orgId, limit, {saved?})`.
- **Firestore:** `saved=true` queries `where("saved","==",true).orderBy("verifiedAt","desc")` → needs a composite index (collection `verifications`: `saved` ASC, `verifiedAt` DESC). **Not generated, not verified** (no emulator).
- `POST /api/verify/save` `{gstin, saved}` → `{gstin, saved}`. `checks:run`. 404 `VERIFICATION_NOT_FOUND` if the GSTIN was never verified by this org (you save what you looked up), 400/`INVALID_GSTIN` for bad input.
- `GET /api/verify/recent?limit=&saved=1` → items now include `saved`. `VerificationView.saved` is set on every outcome.

---

## Implementation notes — milestone 8b: smart verification engine (2026-10-06)
- `POST /api/verify` body: `{gstin, mode?: "auto"|"refresh"|"live", force?}` (default `auto`; `force:true` = `live`; invalid mode → 400 VALIDATION_ERROR). Response view gains `staleness (fresh|stale|expired)`, `refreshRecommended`, `refreshSkipped (provider_down|provider_degraded|quota)`, `joined`, `providerHealth`.
- `GET /api/verify/health` now also returns `providerHealth {state, reason?, samples, successRate, p95Ms, consecutiveFailures, lastFailureAt}`; metrics gain `providerCalls, callsAvoided, joined, staleServed`.
- No new collections or indexes. Freshness/health policy is environment configuration: `VERIFY_FRESH_MS, VERIFY_STALE_USABLE_MS, VERIFY_HEALTH_WINDOW_MS, VERIFY_HEALTH_MAX_SAMPLES, VERIFY_HEALTH_MIN_SAMPLES, VERIFY_DEGRADED_FAILURE_RATE, VERIFY_DEGRADED_P95_MS, VERIFY_DOWN_CONSECUTIVE, VERIFY_DOWN_HOLD_MS, VERIFY_PROBE_INTERVAL_MS` — **all defaults unverified against any provider's caching/reuse terms**.


---

## Implementation notes — milestone 9: bulk GSTIN verification and CA workflow (2026-10-06)
- `BulkJob.kind?: "check" | "verify"` (absent = "check"). Verify jobs: `includeReturns:false`, items `clientId: ""`, same counts/quota fields and the same `bulk` job/item/idempotency collections as bulk checks. Job views now carry `kind`; item views carry `verification` (outcome, details, verifiedAt, saved, note, tags) for verify jobs (joined from `verifications/{GSTIN}`, answered items only).
- `VerificationRecord` gains `note?` (≤ 500) and `tags?` (≤ 5 × ≤ 24 chars). `Store.listVerifications(orgId, limit, {saved?, tag?})`; Firestore `tag` = `where("tags","array-contains",tag).orderBy("verifiedAt","desc")` → composite index (tags, verifiedAt desc) **unverified** (plus the saved index from milestone 8).
- `VerificationService.verify(ctx, gstin, {held:true})`: the caller holds the quota unit and settles it (live status → consume; stored / NOT_FOUND / failure → release); the service neither reserves nor refunds.

| Method | Path | Notes |
|---|---|---|
| POST | /api/bulk-verify/preview | `{gstins[], force?}` → `{preview}`: lines, valid, invalid[] (first 200, with reason) + invalidCount, duplicates, needsLiveCheck, servedFromCache, quota{…sufficient}, providerRequests, estimatedSeconds, bulkAllowed. Body ≤ 3 MB. `checks:run`. Consumes nothing. |
| POST | /api/bulk-verify | start. `{gstins[], force?, allowPartial?}` + optional `Idempotency-Key`. **202** new / **200** replay → `{job, replay, rejected{invalidCount, duplicates}}`. Errors: 400 `NO_VALID_GSTINS` / `TOO_MANY_ITEMS` (> 10,000 valid) / `VALIDATION_ERROR`, 402 `QUOTA_EXHAUSTED`, 403 `FEATURE_NOT_AVAILABLE` (plan) / `SUBSCRIPTION_INACTIVE` / `FORBIDDEN`. |
| GET | /api/bulk-checks/{id}[/items] · POST …/cancel \| retry-failed \| resume | shared with bulk checks; work for verify jobs unchanged. |
| GET | /api/bulk-checks/{id}/export | verify jobs only (400 `NOT_A_VERIFY_JOB` otherwise). `text/csv; charset=utf-8` attachment, UTF-8 BOM, formula-safe, columns: GSTIN, Result, Source of answer, Legal name, Trade name, Taxpayer type, State, Registration date, Answer obtained at, Error, Tags, Note, Saved. `X-Failed-Rows-Truncated: true` when capped at 10,000. `clients:read`. |
| POST | /api/verify/annotate | `{gstin, note?, tags?}`; omitted = unchanged, `""`/`[]` clear. 404 `VERIFICATION_NOT_FOUND`, 400 limits. `checks:run`. |
| GET | /api/verify/recent?tag= | filters by tag (exact). |


---

## Implementation notes — milestone 13: GST cost control (2026-10-06)

### Data
```text
costCounters/{scope}__{period}   scope = "global" | "org:{orgId}"; period = "day:YYYY-MM-DD" | "month:YYYY-MM"
                                 { searches, paidCalls, cacheHits, sharedHits, cacheMisses, deduped, failures, credits }  (atomic FieldValue.increment; missing fields = 0)
sharedResults/{GSTIN}            { gstin, outcome, details, source, verifiedAt, provenance }   ← ONLY when VERIFY_SHARED_CACHE=on; no org/user identity
organizations/{orgId}/verifications/{GSTIN}   gains provenance?, previous? {outcome, details, verifiedAt}, change? {from,to,at,fields[],deteriorated}
```
Root-level collections are server-only (security rules must deny all client access). No new composite index; Firestore behaviour is **unverified** (no emulator).

### Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | /api/verify/costs | ADMIN/OWNER (`auditlog:read`). `{costs:{today, month, sharedCache, costKnown}}`; each period: searches, paidCalls, cacheHits, sharedHits, cacheMisses, deduped, failures, credits, avoidedCallRate, estimatedCostInr (null unless a price is configured). |
| GET | /api/operator/provider | user ids in `OPERATOR_UIDS` only; everyone else 404. `{provider:{today, month, credits{state,used,budget,remaining,fractionRemaining}, limits, sharedCache}, health}`. |
| POST | /api/verify | response adds `provenance`, `notice` (`REFRESH_TOO_SOON` or `CREDIT_PROTECTION`), `change`, the outcome `CAPACITY_LIMITED`, and `refreshSkipped: "capacity"`. |

### Environment (all optional; all UNVERIFIED against a real provider)
`VERIFY_SHARED_CACHE=on` · `VERIFY_MIN_REFRESH_MS` (0) · `VERIFY_ORG_PER_MINUTE` (120) · `VERIFY_ORG_PER_DAY` (5000) · `VERIFY_GLOBAL_PER_DAY` (0 = off) · `PROVIDER_MONTHLY_CREDIT_BUDGET` (unset = protection off) · `PROVIDER_CREDITS_PER_CALL` (1) · `VERIFY_LOW_CREDIT_FRACTION` (0.2) · `VERIFY_CRITICAL_CREDIT_FRACTION` (0.05) · `PROVIDER_COST_PER_CREDIT_INR` (unset) · `OPERATOR_UIDS` (comma-separated user ids).

---

## Implementation notes — milestone 10: pricing and archived clients (2026-10-06)
- `Client.status` ("active" | "archived") is now used. `GstinRecord.archived?: boolean` is denormalized from it and **hidden by default** in every GSTIN list/count/filter (`GstinFilter.archived = true` returns only archived). `Store.countClients(orgId, status = "active")` and `Store.listClients(orgId, {status = "active" | "archived" | "all"})`.
- New endpoints: `POST /api/clients/{id}/archive`, `POST /api/clients/{id}/restore` (`clients:write`, writable subscription; idempotent; restore is subject to the plan cap; audit `CLIENT_ARCHIVED` / `CLIENT_RESTORED`). `GET /api/clients?status=`, `GET /api/gstins?archived=true`. Checking an archived client → 409 `CLIENT_ARCHIVED`.
- `GET /api/subscription` now returns `clients {used (active), archived, included, limit}` and `pricing {period, bill, nextClient, cheaper?}`; `bill` = `{planId, period, activeClients, includedClients, extraClients, extraClientInr, baseInr, extraInr, totalInr, perMonthInr, annualSavingInr, custom, overCap}`.
- **Firestore (UNVERIFIED, no emulator):** `gstins.archived` is always written as a boolean and every GSTIN query adds `archived == false|true`; `clients` queries add `status ==`. All existing composite indexes need `archived`/`status` added; none are generated. Records written before this change have no `archived` field and would not match the equality filter (no production data exists).


---

## Implementation notes — milestone 10: trust and safety (2026-10-06)
### Data
```text
organizations/{orgId}/concerns/{id}   Concern { id, organizationId, gstin, category, description, reportedBy, createdAt, status open|reviewed|closed,
                                      snapshot? {outcome, verifiedAt, source, legalName?}, resolution?, reviewedBy?, updatedAt? }   ← INTERNAL; never leaves the organization
```
Firestore indexes (composite, **not generated, unverified**): concerns (`status` ASC, `createdAt` DESC), (`gstin` ASC, `createdAt` DESC). `Store.deleteVerification`, `createConcern/getConcern/listConcerns/updateConcern` are in the shared store contract (Firestore variant skipped: no emulator). New `AuditAction`s: VERIFICATION_SAVED, VERIFICATION_ANNOTATED, VERIFICATION_DELETED, VERIFICATION_HISTORY_CLEARED, CONCERN_REPORTED, CONCERN_UPDATED. **Audit metadata holds only codes, counts and ids** (gstin, category, outcome, status, noteChanged, tagCount, removed) — never typed text.

### Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | /api/concerns | `{gstin, category, description}`. `checks:run`. **201** new / **200** `{duplicate:true}` for an identical open concern by the same user within 24 h. 400 `VALIDATION_ERROR` / `INVALID_GSTIN`, 429 `CONCERN_LIMIT` (20 per user per day). |
| GET | /api/concerns?status=&gstin=&limit= | newest first (max 200). `checks:run`. |
| PATCH | /api/concerns/{id} | `{status, resolution?}`. `auditlog:read` (owner/admin). 404 `CONCERN_NOT_FOUND` (also for another org's id). |
| GET | /api/audit-logs?action=&limit= | newest first (max 500) → rows `{id, at, action, label, who, whoUid, target?, metadata?}`. `auditlog:read`. |
| GET | /api/audit-logs/export | CSV (UTF-8 BOM, formula-safe), up to 500 rows. `auditlog:read`. |
| POST | /api/verify/forget | `{gstin}` → `{gstin, removed}`. `checks:run`. Idempotent. |
| DELETE | /api/verify/history | → `{removed}`. `auditlog:read` (owner/admin). |


---

## Implementation notes — milestone 14: client portfolio (2026-10-06)

### Data
```text
organizations/{orgId}/clients/{id}   gains verifySchedule? ("daily"|"weekly"|"monthly"), nextVerifyAt? (ISO), lastScheduledAt? (ISO)
```
Clearing a schedule deletes both fields (`FieldValue.delete()` — `ignoreUndefinedProperties` would otherwise keep them). The scheduler uses a **collection-group query** `clients where nextVerifyAt <= now order by nextVerifyAt` (needs a collection-group index on `clients.nextVerifyAt`; **unverified**, no emulator); results are re-checked for `status == "active"` and a schedule.

### Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | /api/portfolio | `q, status (outcome or "never"), freshness (fresh/stale/expired/never), changed=1, tag, assignedTo, scheduled=1/0, needsRefresh=1, attention=1, sort (name/attention/oldest), limit (≤100), cursor`. → `{items[], total, nextCursor?, summary, truncated}`. Row: `clientId, name, gstin, status|null, statusSource ("verification"/"check"), legalName?, verifiedAt?, ageSeconds?, freshness, change?, tags?, saved?, schedule?, nextVerifyAt?`. All roles. Invalid filter values are ignored; bad cursor → 400. |
| POST | /api/portfolio/gstins | `{scope: needs_refresh/attention/all/selected, clientIds?}` → `{gstins[], count, truncated}`; `checks:run`. Feed the list to `/api/bulk-verify/preview` and `/api/bulk-verify`. Foreign client ids match nothing. |
| POST | /api/portfolio/schedule | `{clientIds[] \| all:true, schedule: "daily"/"weekly"/"monthly"/null}` → `{updated, schedule}`. `clients:write`; turning on needs plan feature `scheduledChecks` (403 `FEATURE_NOT_AVAILABLE`) and a writable subscription (403 `SUBSCRIPTION_INACTIVE`). |
| POST | /api/portfolio/run-due | `checks:run`. One bulk-verify job for this organization's due clients (≤ 500 per run, `Idempotency-Key` `sched:<minute>:<hash>`) → `{due, started, jobId?, gstins?, replay?}`; **202** when a job started. Throws like a manual bulk run (quota…); on a throw nothing advances. |
| POST | /api/internal/portfolio-due | `Authorization: Bearer $CRON_SECRET`. 404 unless the secret is set and matches. → `{results:[{orgId, due, started, jobId?, skipped?}]}`; runs as `system:scheduler` (OWNER role, audit user id). |

### Environment
`CRON_SECRET` (enables the scheduler endpoint; unset = endpoint does not exist).

---

## Implementation notes — milestone 12: multi-GSTIN client firms (2026-10-06)
- `Client.gstin` = primary (immutable); `Client.gstins?: string[]` = all GSTINs incl. primary, stored only once a second GSTIN is added (absent = `[gstin]`). One `gstins/{GSTIN}` record per GSTIN (unchanged), linked by `clientId`.
- Endpoints: `GET /api/clients/{id}/gstins` → `[{gstin, primary, state, status, checked, lastCheckedAt, indicator}]`; `POST /api/clients/{id}/gstins {gstin}` → 201 `{client, gstins}`; `DELETE /api/clients/{id}/gstins/{gstin}`; `POST /api/gst/check` accepts `gstin`. Errors: `CLIENT_GSTIN_LIMIT_REACHED` 402, `GSTIN_PAN_MISMATCH` 422, `DUPLICATE_GSTIN` 409, `CANNOT_REMOVE_PRIMARY_GSTIN` 409, `GSTIN_NOT_ON_CLIENT` 404, `CLIENT_ARCHIVED` 409. Limits: `PlanConfig.gstinsPerClient`.
- Store: `findClientByGstin` and `allGstins` consider `gstins`; client search matches any GSTIN. **Firestore (UNVERIFIED):** `findClientByGstin` falls back to `where("gstins","array-contains",g)`; `allGstins` selects `gstin` and `gstins`; the client-name/GSTIN prefix search (`orderBy("gstin")`) still searches the primary only. No index generated, no emulator run.
- Portfolio rows (`GET /api/portfolio`) add `gstins`, `gstinCount`, `statusGstin` only for multi-GSTIN clients.


---

## Implementation notes — milestone 11: performance (2026-10-06)
- `Store.getVerifications(orgId, gstins[])` → the stored answers that exist (missing = absent, de-duplicated, org-scoped). Firestore: `db.getAll(...refs)` in chunks of 300 (one round trip each). Used by bulk preview/start (`liveNeeded`), the verify-job results join and CSV export. In the shared store contract (Firestore variant skipped: **unverified**).
- Hot-path round trips (critical path, counting each parallel group once): stored lookup 3 (`getOrg‖getVerification` → `record(searches)‖creditStatus` → `recordCached‖record(cacheHits)`); live lookup 5 (… → `getCost×2` in `admit` → `usage.reserve` → `record‖putVerification‖audit`). `tests/perf.test.ts` fails if these grow.
- Counter semantics unchanged except one write: a live call records `cacheMisses` and `paidCalls` together after the provider returns (previously `cacheMisses` was written before the call). A process crash during the provider call therefore loses that one miss count; spend (`paidCalls`/credits) was already recorded after the call.


---

## Implementation notes — milestone 15: alerts + reports (2026-10-06)

### Data
`organizations/{orgId}/alerts/{id}` is unchanged in shape (`{id, type, message, gstin?, at, read}`); `addAlert` is now an **upsert by id** (idempotent events). `listAlerts(orgId, limit, {unread})` with `unread=true` is `where read == false order by at desc` — needs a composite index (`read` ASC, `at` DESC), **unverified** (no emulator). `markAlerts` updates in batches of 400 (all: up to 8,000 per call); `countUnreadAlerts` uses a Firestore `count()` aggregate. Read state is organization-wide.

### Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | /api/alerts | `unread=1`, `group=status/returns/usage/jobs/system`, `limit` (≤200, default 30) → `{items, unreadCount, hasMore}`. All roles. Unknown group → 400. |
| POST | /api/alerts/read | `{ids[] (1–1000) \| all:true, read?: boolean}` → `{changed, unreadCount}`. `checks:run`. Ids of other organizations are ignored. |
| GET | /api/reports/{clients\|attention\|changes\|returns} | JSON preview `{kind,title,description,generatedAt,columns,rows (first 100),total,truncated,notes}`; `reports:read`. `returns` takes `returnType` (GSTR1/GSTR3B), `fy` (2026-27), `scope=all`. Unknown kind → 404; bad filter → 400. |
| GET | /api/reports/{kind}?format=csv | `reports:generate`. `text/csv; charset=utf-8` attachment `<kind>-report-YYYY-MM-DD.csv`, UTF-8 BOM, all cells quoted + formula-neutralised, CRLF, `X-Report-Rows`, `X-Report-Truncated`, `nosniff`; ≤ 20,000 rows; audit `REPORT_GENERATED` (`{rows, format}`). |
| GET | /api/reports/summary | `reports:read`; plan feature `pdfReports` (403 `FEATURE_NOT_AVAILABLE` otherwise). `{summary:{generatedAt, organization, portfolio, truncated, attention[≤25], changes[≤25], returns{gstr1Missing,gstr3bMissing,gstr1Late,gstr3bLate}, notes[]}}`. |
