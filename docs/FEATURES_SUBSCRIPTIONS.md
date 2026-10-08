# GST CA Platform — FEATURES_SUBSCRIPTIONS.md

## 1. Product positioning

### Working concept

> **The GST Compliance Workspace for CA Firms**

Instead of being only a GSTIN lookup tool, the product should help a CA firm manage its entire GST checking workflow:

```text
Import clients
→ Verify GSTIN
→ Check GSTR-1
→ Check GSTR-3B
→ Identify missing/late filings
→ Monitor clients
→ Export reports
→ Send reminders
→ Repeat automatically
```

---

# 2. Core features

## A. CA Firm Dashboard

Show:

- Total clients
- Total GSTINs
- Active GSTINs
- Cancelled/suspended GSTINs
- GSTR-1 filed
- GSTR-1 missing
- GSTR-3B filed
- GSTR-3B missing
- Late filings
- Checks remaining
- API usage
- Last sync
- Alerts

## B. Client Management

Each client can have:

- Business name
- Legal name
- Trade name
- GSTIN
- PAN, if legally appropriate and required
- Contact person
- Email
- Phone
- Assigned CA/accountant
- Filing frequency
- Client notes
- Documents
- Compliance status

## C. GSTIN Verification

One-click:

```text
GSTIN
Legal Name
Trade Name
Registration Status
Taxpayer Type
Registration Date
Cancellation Date
Principal Place
State
E-invoice status, if provider supports it
Last checked
```

Status:

- Active
- Cancelled
- Suspended
- Inactive
- Error / unavailable

## D. GSTR-1 monitoring

For each client:

- Filing status
- Filing period
- Filing date
- ARN
- Due date
- Late/On-time indicator
- Missing-period indicator
- Last successful filing

## E. GSTR-3B monitoring

Same workflow:

- Filing status
- Filing period
- Filing date
- ARN
- Due date
- Late/On-time indicator
- Missing-period indicator
- Last successful filing

## F. Bulk CSV Upload

Example:

```csv
client_name,gstin,email,phone
ABC Industries,24AAAAA0000A1Z5,abc@example.com,9876543210
XYZ Traders,24BBBBB0000B1Z6,xyz@example.com,9876543211
```

After upload:

```text
1,000 rows
↓
982 valid GSTINs
↓
12 duplicates
↓
6 invalid GSTINs
↓
982 checks queued
```

Allow:

- Preview
- Validation
- Duplicate detection
- Mapping columns
- Import history
- Download failed rows
- Download results

## G. Bulk GST Check

CA can select:

```text
☑ All clients
☑ Selected clients
☑ Only overdue clients
☑ Only inactive GSTINs
☑ Only clients not checked for 7 days
```

Then:

**Run GST Check**

The queue processes jobs according to subscription and provider limits.

## H. Client Compliance Score

Avoid making the score look like an official government rating.

Use an internal label:

```text
Good
Needs Attention
High Attention
Data Unavailable
```

Possible inputs:

- GSTIN status
- GSTR-1 filing consistency
- GSTR-3B filing consistency
- late filing count
- missing periods

Clearly label:

> Internal compliance indicator. Not a government rating.

## I. Alerts

Examples:

> GSTIN 24AAAAA0000A1Z5 changed from Active to Suspended.

> ABC Industries has a missing GSTR-3B return for August 2026.

> 42 client GST checks failed because your monthly quota is exhausted.

> Your plan has 8% GST-check capacity remaining.

## J. Reports

Export:

- Client GST status
- GSTR-1 status
- GSTR-3B status
- Missing returns
- Late returns
- GSTIN changes
- Monthly CA compliance report

Formats:

- CSV
- Excel
- PDF

---

# 3. Advanced features

## Phase 2

- Automated scheduled checks
- Email alerts
- Client reminders
- Team members
- Assign clients to accountants
- Activity/audit log
- Dashboard filters
- Saved reports
- Bulk exports

## Phase 3

- Client portal
- White-label reports
- WhatsApp reminders
- E-invoice status
- E-way bill
- GSTR-2B / ITC reconciliation
- Advanced reconciliation
- Filing calendar
- CA firm API
- Custom webhooks

---

# 4. Subscription architecture

Use four plans.

## Free

Target: trial users and individual CAs testing the platform.

### Suggested limits

- 25 clients
- 50 GSTIN checks/month
- 1 user
- CSV upload
- GSTIN verification
- Basic GSTR-1/GSTR-3B history
- Basic dashboard
- CSV export

No scheduled monitoring.

---

## Starter

### ₹499/month
### ₹4,990/year

Target: small CA / tax consultant.

Includes:

- 100 clients
- 500 GST checks/month
- 2 users
- CSV bulk import
- Bulk GST checks
- GSTR-1 monitoring
- GSTR-3B monitoring
- Compliance alerts
- CSV/Excel export
- 30-day check history
- Email support

---

## Professional

### ₹999/month
### ₹9,990/year

Target: growing CA firm.

Includes:

- 500 clients
- 2,000 GST checks/month
- 5 users
- Everything in Starter
- Scheduled monitoring
- Filing alerts
- Client assignment
- Advanced dashboard
- PDF reports
- Audit logs
- 1-year history
- Priority support

---

## Firm

### ₹2,499/month
### ₹24,990/year

Target: established CA firms.

Includes:

- 2,000 clients
- 10,000 GST checks/month
- 15 users
- Everything in Professional
- Multiple teams
- Advanced permissions
- White-label reports
- Client portal
- Automated email reminders
- Webhooks
- Advanced exports
- 3-year history
- Priority support

---

## Enterprise

### Custom pricing

For:

- 2,000+ clients
- 10,000+ checks/month
- Large CA networks
- ERP/accounting integrations
- Resellers

Includes:

- Custom limits
- Dedicated API capacity
- Custom GST API provider arrangement
- SLA
- Dedicated support
- SSO
- Custom integrations
- White-label platform
- Dedicated infrastructure options

---

# 5. Monthly vs annual

Recommended annual discount:

```text
Monthly price × 10
```

Instead of charging 12 months.

| Plan | Monthly | Annual |
|---|---:|---:|
| Free | ₹0 | ₹0 |
| Starter | ₹499 | ₹4,990 |
| Professional | ₹999 | ₹9,990 |
| Firm | ₹2,499 | ₹24,990 |
| Enterprise | Custom | Custom |

The annual plan effectively gives approximately two months free.

---

# 6. Overage policy

Do not silently stop important compliance workflows.

When a CA reaches 80%:

> You have used 80% of this month's GST checks.

At 100%:

Option A:

> Upgrade your plan

Option B:

> Buy additional GST credits

Recommended:

```text
Professional overage: ₹0.60/check
Firm overage: ₹0.45/check
Enterprise: negotiated
```

Actual overage price must be adjusted after the GST API provider contract is finalized.

---

# 7. Feature matrix

| Feature | Free | Starter | Professional | Firm | Enterprise |
|---|---|---|---|---|---|
| Clients | 25 | 100 | 500 | 2,000 | Custom |
| Users | 1 | 2 | 5 | 15 | Custom |
| GST checks/month | 50 | 500 | 2,000 | 10,000 | Custom |
| GSTIN verification | ✓ | ✓ | ✓ | ✓ | ✓ |
| GSTR-1 history | ✓ | ✓ | ✓ | ✓ | ✓ |
| GSTR-3B history | ✓ | ✓ | ✓ | ✓ | ✓ |
| CSV import | ✓ | ✓ | ✓ | ✓ | ✓ |
| Bulk checks | — | ✓ | ✓ | ✓ | ✓ |
| Scheduled checks | — | — | ✓ | ✓ | ✓ |
| Alerts | — | ✓ | ✓ | ✓ | ✓ |
| Excel export | ✓ | ✓ | ✓ | ✓ | ✓ |
| PDF reports | — | — | ✓ | ✓ | ✓ |
| Team management | — | Basic | ✓ | Advanced | Custom |
| Audit log | — | — | ✓ | ✓ | ✓ |
| Client portal | — | — | — | ✓ | ✓ |
| White-label | — | — | — | ✓ | ✓ |
| Webhooks | — | — | — | ✓ | ✓ |
| API access | — | — | — | Optional | ✓ |
| Dedicated support | — | — | Priority | Priority | ✓ |
| Custom limits | — | — | — | — | ✓ |

---

# 8. Subscription enforcement

Backend should maintain:

```json
{
  "plan": "professional",
  "clientLimit": 500,
  "monthlyGstChecks": 2000,
  "usedGstChecks": 1375,
  "remainingGstChecks": 625,
  "teamMemberLimit": 5,
  "scheduledChecks": true
}
```

Every protected operation checks:

```text
Authentication
↓
Organization membership
↓
Subscription active?
↓
Feature available?
↓
Quota available?
↓
Provider rate limit
↓
Execute
```

---

# 9. Billing states

Support:

```text
trialing
active
past_due
cancelled
expired
paused
```

Never delete client data immediately after subscription cancellation.

Recommended:

```text
Cancellation
↓
Account remains accessible until paid period ends
↓
Read-only grace period
↓
Data retention period
↓
Deletion only after clear policy/confirmation
```

---

# 10. CA dashboard navigation

```text
Dashboard
Clients
GSTINs
Bulk Import
GST Checks
GSTR-1
GSTR-3B
Alerts
Reports
Team
Usage & Billing
Settings
Audit Logs
```

---

# 11. The strongest MVP

Do not build every CA task on day one.

The MVP should solve one deep problem extremely well:

> **"Give me the GST compliance status of all my clients without manually checking every GSTIN and return."**

MVP workflow:

```text
CA signs up
↓
Uploads 500 GSTINs
↓
System validates + deduplicates
↓
Bulk GST checks run safely
↓
Dashboard shows Active / Suspended / Cancelled
↓
GSTR-1 filing history
↓
GSTR-3B filing history
↓
Missing / late returns highlighted
↓
CA exports report
↓
System automatically rechecks clients on schedule
```

That is the core product worth selling before adding accounting, invoicing, e-invoice and other modules.

---

# 12. Commercial warning

GST API cost must be treated as a variable cost.

For example, at ₹0.40/check:

```text
2,000 checks = ₹800
10,000 checks = ₹4,000
50,000 checks = ₹20,000
100,000 checks = ₹40,000
```

Therefore, subscription plans should not promise unlimited live GST API calls.

Use:

**Plan + included checks + paid overage + caching + negotiated API pricing.**

---

# 13. Product success metrics

Track:

- CA firms registered
- Active CA firms
- Clients per CA
- GSTINs imported
- GST checks/month
- % cached checks
- API cost/customer
- Revenue/customer
- Gross margin
- Trial → paid conversion
- Monthly churn
- Annual renewal
- Scheduled-check adoption
- Number of compliance alerts acted upon

The most important early metric:

> **Average number of GST clients actively monitored per paying CA firm.**

---

## Implementation notes (as built — 2026-10-06)

- Plan values live only in `src/config/plans.ts`. Professional = **2,000** checks (TECH.md/DATABASE_API.md examples that say 2,500 are illustrative).
- Subscription belongs to the Organization. Quota, seats and client limits are shared by all members.
- Paid plans selected at signup start a 14-day card-less trial (`trialing`); after the trial the workspace is read-only (`expired`). Data is never deleted. No payment is possible yet (billing provider pending).
- Seats = members + pending invitations. Annual savings are computed from config (currently 17% for Starter/Professional/Firm).

---

## Implementation notes — milestone 3 (2026-10-06)

- **Bulk checks** are gated by `features.bulkChecks` (Free: single check only; Starter and above allowed). Maximum 10,000 GSTINs per job.
- **Quota semantics for bulk:** units are *held* when the job starts (so no one else can spend them), *consumed* per successful live check, *released* for cached results, failures, cancellations. Failed provider calls are not charged unless the provider is flagged as billing errors (unverified per vendor).
- **allowPartial:** if fewer units remain than needed, the job can start with what is left; the shortfall is reported as `skipped`.
- Dashboard shows `quota.{limit,used,reserved,remaining}` — `reserved` is what in-flight bulk jobs are holding.
- Cost note (assumption): at 60 provider requests/min a 2,000-check monthly allowance is ≈ 67 minutes of provider time; the provider contract, not this application, sets the real ceiling.

---

## Implementation notes — milestone 4 (2026-10-06)

- **Pricing page** (`/pricing`) and the landing summary read `src/config/plans.ts`; yearly savings come from `annualSavingsPercent` (currently 17% for Starter / Professional / Firm). Professional is the recommended plan.
- Features that exist on a plan but are **not built yet** are labelled "Soon" on the pricing comparison and landing page: scheduled monitoring, alerts, PDF reports, audit log, client portal, white-label, webhooks, overage billing. Do not remove the label until the feature ships.
- **Onboarding** suggests a plan from the number of clients (≤25 Free, ≤100 Starter, ≤500 Professional, ≤2,000 Firm, more → Enterprise "talk to us"); paid choices start the 14-day card-less trial.
- **Billing page** is read-only: plan, status, trial end, shared usage (checks / seats / clients). Upgrade / change / manage / invoices / cancel are disabled with an explanation until a payment provider is connected.
- Free plan: single GST checks work; multi-client bulk runs show "Bulk checks aren't included in your plan".

---

## Implementation notes — milestone 5: CSV import (2026-10-06)

- **Available on every plan** (roles ACCOUNTANT and above), bounded by the plan's **client limit**: a file that would exceed the remaining slots is refused unless the user chooses to import only what fits (the rest are reported as "over your plan's client limit"). A full plan cannot import. The limit is re-checked while importing.
- **Quota:** importing clients consumes **no** GST checks. The optional "verify right after importing" step uses the normal bulk-check rules: it needs a plan with bulk checks (Starter and above for more than one client), holds/consumes the same shared monthly quota, shows the exact usage and remaining before confirming, and can be limited to "as many as remain". If verification cannot start, the import still succeeds and the result page says why.
- **Read-only subscriptions** (expired trial, cancelled, paused) cannot import; data is never deleted.
- Importing the same file twice is safe: retries replay the original import; re-submitting a finished file reports "no rows can be imported" because every GSTIN already exists.

---

## As built — milestone 10 (pricing model, 2026-10-06)
The plan table and limits in this spec are **superseded** by `src/config/plans.ts` and the README section "Pricing model (milestone 10)": base fee + automatic per-active-client charge above the included count (Starter ₹18, Professional ₹12, Firm ₹8), annual = published annual base + 10 months of overage, archived clients not billed, live-check allowances 10 / 100 / 500 / 2,000, users 1 / 1 / 3 / 10. Prices are exclusive of taxes. Display and preview only: no payment provider exists.
