import type { PlanId, SubscriptionStatus } from "@/config/plans";
import type { Role } from "@/lib/permissions";
import type { FilingFrequency } from "@/lib/dates";
import type { FilingState, Indicator } from "@/lib/compliance";
import type { NormalizedReturn } from "@/lib/returns";
import type { GstinStatus, ReturnStatus, ReturnType } from "@/providers/types";
import type { UsageStore } from "@/lib/usage";
import type { VerificationOutcome, VerifiedDetails, Provenance } from "@/lib/verification";
import type { ChangeInfo, Snapshot } from "@/lib/change-detection";
import type { VerifySchedule } from "@/lib/portfolio";

/** Subscription is owned by the Organization (never by a user); quota/seats/clients are org-wide. */
export interface Organization {
  id: string; name: string; ownerId: string; plan: PlanId; subscriptionStatus: SubscriptionStatus; createdAt: string;
  billingPeriod: "monthly" | "annual"; trialEndsAt?: string; currentPeriodEnd?: string;
}
export interface Member { uid: string; email: string; name?: string; role: Role; addedAt: string; lastActiveAt?: string }
export interface UserProfile { uid: string; email: string; name?: string; createdAt: string }
export interface Invitation {
  /** SHA-256 hash of the emailed token. Safe to expose to admins; useless without the token preimage. */
  id: string; organizationId: string; email: string; role: Role; invitedBy: string;
  createdAt: string; expiresAt: string; status: "pending" | "accepted" | "revoked";
}

export interface Client {
  id: string; name: string; legalName?: string; tradeName?: string;
  /** PRIMARY GSTIN (immutable). */
  gstin: string;
  /** Every GSTIN of this client firm, primary first. Absent on records created before multi-GSTIN support (= [gstin]). */
  gstins?: string[];
  email?: string; phone?: string; contactPerson?: string; assignedTo?: string;
  filingFrequency: FilingFrequency; notes?: string; status: "active" | "archived";
  createdAt: string; updatedAt: string; lastCheckedAt?: string;
  /** Scheduled re-verification (portfolio). Subject to the plan feature and the provider's terms. */
  verifySchedule?: VerifySchedule; nextVerifyAt?: string; lastScheduledAt?: string;
}

/**
 * Latest known GSTIN verification for a client GSTIN (the cache) + denormalized fields that make
 * dashboard counts and list filters indexed single-field queries (no scans, no provider calls).
 * Denormalized compliance fields are "as of lastReturnsAt" and refreshed on every check.
 */
export interface GstinRecord {
  gstin: string; clientId: string; status: GstinStatus;
  clientName?: string; assignedTo?: string;
  /** Denormalized (lastCheckedAt present) so "never checked" is an indexed equality query. */
  checked?: boolean;
  legalName?: string; tradeName?: string; taxpayerType?: string; state?: string;
  source?: string; providerRequestId?: string;
  lastCheckedAt?: string; cacheExpiresAt?: string; lastError?: { code: string; at: string };
  indicator?: Indicator; gstr1Missing?: number; gstr1Late?: number; gstr3bMissing?: number; gstr3bLate?: number;
  lastReturnsAt?: string;
  /** Denormalized from the client (archived clients are not billed, checked or counted). Absent = active. */
  archived?: boolean;
}

export interface GstinFilter {
  /** Archived records are EXCLUDED unless this is true (then ONLY archived ones). */
  archived?: boolean;
  status?: GstinStatus;
  indicators?: Indicator[];
  /** true = checked at least once; false = never checked. */
  checked?: boolean;
  /** Checked GSTINs whose cache expired at or before this ISO time. */
  refreshBefore?: string;
  gstr1Missing?: "none" | "some";
  gstr3bMissing?: "none" | "some";
  gstr1Late?: "some";
  gstr3bLate?: "some";
  assignedTo?: string;
  /** Prefix match on GSTIN or client name. Ignored by countGstins. */
  search?: string;
}
export interface GstinSort { by: "gstin" | "lastCheckedAt"; dir: "asc" | "desc" }

export interface ReturnFilter {
  gstin?: string; returnType?: ReturnType; financialYear?: string; period?: string;
  state?: FilingState; status?: ReturnStatus;
  /** At most one range family per query (Firestore single-range constraint). */
  dueFrom?: string; dueTo?: string; filedFrom?: string; filedTo?: string;
}

export interface CheckEntry {
  id: string; gstin: string; at: string; by: string; outcome: "SUCCESS" | "CACHED" | "FAILED";
  errorCode?: string; source?: string; status?: GstinStatus; jobId?: string;
}

/**
 * Latest stored registry answer for a GSTIN, per organization. Used as the verification cache AND the "recent verifications" list.
 * Only registry answers are stored (never pipeline failures). Keyed by gstin: one record per GSTIN per org.
 */
export interface VerificationRecord {
  gstin: string;
  outcome: VerificationOutcome;
  details?: VerifiedDetails;
  source: string;
  providerRequestId?: string;
  /** When the registry answer was obtained. */
  verifiedAt: string;
  by: string;
  requestId: string;
  /** Pinned by a user ("Saved GSTINs"). Survives re-verification. Organization-wide, not per user. */
  saved?: boolean;
  /** Free-text note and labels (also used as folders). Organization-wide; survive re-verification. */
  note?: string;
  tags?: string[];
  /** Where this stored answer came from (LIVE_PROVIDER / SHARED_CACHE / BATCH). */
  provenance?: Provenance;
  /** The answer this one replaced, and what changed — for change detection. */
  previous?: Snapshot;
  change?: ChangeInfo;
}

/** Normalized provider answer shared across organizations. Contains NO organization or user identity. Only written when sharing is enabled. */
export interface SharedResult {
  gstin: string; outcome: VerificationOutcome; details?: VerifiedDetails; source: string; verifiedAt: string; provenance: Provenance;
}

/** Cost counters for one scope ("global" or "org:<id>") and one period ("day:YYYY-MM-DD" | "month:YYYY-MM"). */
export interface CostCounters {
  /** Valid-GSTIN verification requests received. */
  searches: number;
  /** Paid provider calls actually made. */
  paidCalls: number;
  /** Served from this organization's stored answers. */
  cacheHits: number;
  /** Served from another organization's shared answer. */
  sharedHits: number;
  /** Requests that needed a provider call. */
  cacheMisses: number;
  /** Requests that joined an already-running provider call instead of making their own. */
  deduped: number;
  /** Paid calls that failed (timeout, provider error...). */
  failures: number;
  /** Credits consumed (paidCalls × creditsPerCall). */
  credits: number;
}

export type ConcernCategory = "NOT_EXIST" | "NAME_MISMATCH" | "ADDRESS_SUSPICIOUS" | "DETAILS_INCONSISTENT" | "FAKE_DOCUMENT" | "OTHER";
export type ConcernStatus = "open" | "reviewed" | "closed";
/**
 * An INTERNAL record that a member of the organization has a concern about a GSTIN. It is not submitted to any authority and is not shared
 * outside the organization. The snapshot is what the member saw at the time (so a later change in the registry does not rewrite history).
 */
export interface Concern {
  id: string; organizationId: string; gstin: string; category: ConcernCategory; description: string;
  reportedBy: string; createdAt: string; status: ConcernStatus;
  snapshot?: { outcome: VerificationOutcome; verifiedAt: string; source: string; legalName?: string };
  resolution?: string; reviewedBy?: string; updatedAt?: string;
}

export type AuditAction =
  | "LOGIN" | "CLIENT_CREATED" | "CLIENT_UPDATED" | "CLIENT_DELETED" | "GST_CHECK" | "CSV_IMPORTED"
  | "CSV_EXPORT" | "REPORT_GENERATED" | "TEAM_MEMBER_ADDED" | "TEAM_MEMBER_REMOVED" | "ROLE_CHANGED"
  | "SUBSCRIPTION_CHANGED" | "BILLING_EVENT" | "CLIENT_ARCHIVED" | "CLIENT_RESTORED" | "BULK_CHECK_STARTED" | "BULK_CHECK_CANCELLED" | "GST_VERIFY"
  | "VERIFICATION_SAVED" | "VERIFICATION_ANNOTATED" | "VERIFICATION_DELETED" | "VERIFICATION_HISTORY_CLEARED" | "CONCERN_REPORTED" | "CONCERN_UPDATED";
export interface AuditEntry {
  id: string; organizationId: string; userId: string; action: AuditAction; target?: string;
  at: string; metadata?: Record<string, string | number | boolean>;
}

export type AlertType =
  | "GSTIN_STATUS_CHANGED" | "GSTIN_SUSPENDED" | "GSTIN_CANCELLED" | "GSTR1_MISSING" | "GSTR3B_MISSING"
  | "LATE_RETURN" | "API_FAILURE" | "QUOTA_NEAR_LIMIT" | "QUOTA_EXHAUSTED" | "SUBSCRIPTION_EXPIRING" | "PAYMENT_FAILURE"
  | "BULK_CHECK_COMPLETED" | "IMPORT_COMPLETED";
export interface Alert { id: string; type: AlertType; message: string; gstin?: string; at: string; read: boolean }

// ---- Bulk jobs ----------------------------------------------------------------------------------

export type JobStatus = "queued" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export type JobItemStatus = "queued" | "processing" | "succeeded" | "cached" | "failed" | "cancelled";

/**
 * Counts are maintained ONLY through Store.incrementJob (atomic) / claim operations, never by callers
 * assigning totals, so concurrent workers cannot corrupt them.
 * Quota accounting (units): reserved = held at creation; consumed + released + (still held) = reserved.
 */
export interface BulkJob {
  id: string; organizationId: string; requestedBy: string; status: JobStatus;
  createdAt: string; startedAt?: string; completedAt?: string;
  includeReturns: boolean; force: boolean;
  /** "check" (default; client GSTINs, full GST check) or "verify" (ad-hoc GSTIN list, registry status only; items have clientId ""). */
  kind?: "check" | "verify";
  total: number;                      // items in the job
  counts: { queued: number; processing: number; succeeded: number; cached: number; failed: number; cancelled: number };
  quota: { requested: number; reserved: number; consumed: number; released: number };
  /** Selection items that could not be added (e.g. unknown/foreign client ids, quota shortfall with allowPartial). */
  skipped: number;
  errorCode?: string;                 // job-level error code only; never raw provider text
  fingerprint: string;
}
export interface BulkJobItem {
  id: string; jobId: string; clientId: string; gstin: string; status: JobItemStatus;
  attempts: number; claimedAt?: string; completedAt?: string;
  /** Needs live provider call (counted in quota hold) vs. expected to be served from fresh cache. */
  held: boolean;
  /** True once this item's quota hold has been settled (guards against double settlement). */
  settled: boolean;
  errorCode?: string; retryable?: boolean;
}
export type JobDeltas = Partial<BulkJob["counts"]> & {
  consumed?: number; released?: number; skipped?: number; reserved?: number;
};

// ---- CSV imports --------------------------------------------------------------------------------

export type ImportStatus = "queued" | "processing" | "completed" | "completed_with_errors" | "failed";
export interface ImportRowData { line: number; name: string; gstin: string; email?: string; phone?: string }
export interface ImportFailedRow { line: number; name: string; gstin: string; email: string; phone: string; reason: string }

/**
 * A CSV import. Validated rows are stored in chunks (never in this document), failed rows are kept here up to a cap
 * so the "download failed rows" report works from history. Counters change only through Store.incrementImport.
 */
export interface ImportRecord {
  id: string; organizationId: string; createdBy: string; fileName: string; status: ImportStatus;
  createdAt: string; startedAt?: string; completedAt?: string;
  totalRows: number;
  counts: { valid: number; invalid: number; duplicate: number; existing: number; skippedPlanLimit: number; imported: number; failedToCreate: number };
  /** Valid rows queued for creation (valid minus plan-limit skips) and how many have been processed so far. */
  toCreate: number; processed: number;
  chunks: number; nextChunk: number;
  verify?: { requested: boolean; includeReturns: boolean; allowPartial: boolean; jobId?: string; errorCode?: string };
  failedRows: ImportFailedRow[]; failedRowsTruncated: boolean;
  errorCode?: string; fingerprint: string;
}
export type ImportDeltas = { imported?: number; failedToCreate?: number; processed?: number; skippedPlanLimit?: number };

export interface Page<T> { items: T[]; nextCursor?: string }

/**
 * Every method takes organizationId FIRST. Callers must derive it from the authenticated
 * membership (never from request input). Implementations must never return data across orgs.
 */
export interface Store {
  usage: UsageStore;
  createOrg(org: Organization, owner: Member): Promise<void>;
  getOrg(orgId: string): Promise<Organization | null>;
  updateOrg(orgId: string, patch: Partial<Omit<Organization, "id" | "createdAt" | "ownerId">> & { ownerId?: string }): Promise<void>;
  putUser(u: UserProfile): Promise<void>;
  getUser(uid: string): Promise<UserProfile | null>;
  /** All organizations the user belongs to (multi-org support). */
  listMemberships(uid: string): Promise<{ organization: Organization; member: Member }[]>;
  putInvitation(i: Invitation): Promise<void>;
  getInvitation(tokenHash: string): Promise<Invitation | null>;
  listInvitations(orgId: string): Promise<Invitation[]>;
  /** Membership lookup used to derive the tenant from a user id. */
  findMembership(uid: string): Promise<{ organizationId: string; member: Member } | null>;
  getMember(orgId: string, uid: string): Promise<Member | null>;
  listMembers(orgId: string): Promise<Member[]>;
  putMember(orgId: string, m: Member): Promise<void>;
  removeMember(orgId: string, uid: string): Promise<void>;

  createClient(orgId: string, c: Client): Promise<void>;
  getClient(orgId: string, id: string): Promise<Client | null>;
  /** Batch lookup (org-scoped): ids that do not belong to the org are simply absent from the result. */
  getClientsByIds(orgId: string, ids: string[]): Promise<Client[]>;
  updateClient(orgId: string, id: string, patch: Partial<Client>): Promise<void>;
  deleteClient(orgId: string, id: string): Promise<void>;
  /** `status` defaults to "active"; "all" includes archived clients. */
  listClients(orgId: string, o: { limit: number; cursor?: string; search?: string; status?: "active" | "archived" | "all" }): Promise<Page<Client>>;
  /** Counts ACTIVE clients by default (the billable number). Pass "archived" for the archived count. */
  countClients(orgId: string, status?: "active" | "archived"): Promise<number>;
  /** Clients (all organizations) whose scheduled re-verification is due at or before `beforeIso`, soonest first. For the scheduler. */
  listDueClients(beforeIso: string, limit: number): Promise<{ orgId: string; clientId: string; gstin: string; nextVerifyAt: string }[]>;
  allGstins(orgId: string): Promise<Set<string>>;
  findClientByGstin(orgId: string, gstin: string): Promise<Client | null>;

  getGstinRecord(orgId: string, gstin: string): Promise<GstinRecord | null>;
  getGstinRecords(orgId: string, gstins: string[]): Promise<GstinRecord[]>;
  putGstinRecord(orgId: string, r: GstinRecord): Promise<void>;
  /** Removes a GSTIN record and all of its stored returns (used when a client is deleted). */
  deleteGstinData(orgId: string, gstin: string): Promise<void>;
  listGstins(orgId: string, f: GstinFilter, o: { limit: number; cursor?: string; sort: GstinSort }): Promise<Page<GstinRecord>>;
  countGstins(orgId: string, f: GstinFilter): Promise<number>;

  /** Upsert by return id (does not delete other periods/years). */
  putReturns(orgId: string, gstin: string, records: NormalizedReturn[]): Promise<void>;
  listReturns(orgId: string, gstin: string): Promise<NormalizedReturn[]>;
  queryReturns(orgId: string, f: ReturnFilter, o: { limit: number; cursor?: string; dir: "asc" | "desc" }): Promise<Page<NormalizedReturn>>;

  addCheck(orgId: string, c: CheckEntry): Promise<void>;
  listChecks(orgId: string, limit: number): Promise<CheckEntry[]>;
  getVerification(orgId: string, gstin: string): Promise<VerificationRecord | null>;
  putVerification(orgId: string, r: VerificationRecord): Promise<void>;
  /** Batch read (performance): the records that exist, in no particular order. Missing GSTINs are simply absent. Firestore: one round trip per 300. */
  getVerifications(orgId: string, gstins: string[]): Promise<VerificationRecord[]>;
  /** Most recently verified first. */
  listVerifications(orgId: string, limit: number, o?: { saved?: boolean; tag?: string }): Promise<VerificationRecord[]>;
  /** Atomic counter increments. */
  bumpCost(scope: string, period: string, d: Partial<CostCounters>): Promise<void>;
  getCost(scope: string, period: string): Promise<CostCounters>;
  getSharedResult(gstin: string): Promise<SharedResult | null>;
  putSharedResult(r: SharedResult): Promise<void>;
  /** Removes one stored verification answer (privacy: "forget this lookup"). No-op if absent. */
  deleteVerification(orgId: string, gstin: string): Promise<void>;
  createConcern(orgId: string, c: Concern): Promise<void>;
  getConcern(orgId: string, id: string): Promise<Concern | null>;
  /** Newest first. */
  listConcerns(orgId: string, o: { limit: number; status?: ConcernStatus; gstin?: string }): Promise<Concern[]>;
  updateConcern(orgId: string, id: string, patch: Partial<Pick<Concern, "status" | "resolution" | "reviewedBy" | "updatedAt">>): Promise<Concern | null>;
  addAudit(e: AuditEntry): Promise<void>;
  listAudit(orgId: string, limit: number): Promise<AuditEntry[]>;
  /** Upsert by id: a deterministic id makes an alert idempotent (the same event is never listed twice). */
  addAlert(orgId: string, a: Alert): Promise<void>;
  /** Newest first. */
  listAlerts(orgId: string, limit: number, o?: { unread?: boolean }): Promise<Alert[]>;
  /** Marks alerts read/unread (`ids` that do not belong to the organization are ignored, or `all`). Returns how many changed. */
  markAlerts(orgId: string, o: { ids?: string[]; all?: boolean }, read: boolean): Promise<number>;
  countUnreadAlerts(orgId: string): Promise<number>;

  // ---- bulk jobs / idempotency
  createJob(orgId: string, job: BulkJob, items: BulkJobItem[]): Promise<void>;
  getJob(orgId: string, id: string): Promise<BulkJob | null>;
  listJobs(orgId: string, limit: number): Promise<BulkJob[]>;
  /** Atomic counter update (+ optional status/timestamps). The ONLY way job counts change. */
  incrementJob(orgId: string, id: string, d: JobDeltas, patch?: Partial<Pick<BulkJob, "status" | "startedAt" | "completedAt" | "errorCode">>): Promise<BulkJob | null>;
  listJobItems(orgId: string, jobId: string, o: { status?: JobItemStatus; limit: number; cursor?: string }): Promise<Page<BulkJobItem>>;
  /** Atomically move up to n items queued → processing (attempts++). Two workers never get the same item. */
  claimJobItems(orgId: string, jobId: string, n: number, nowIso: string): Promise<BulkJobItem[]>;
  /** Item completion. `settled` transitions false→true exactly once; returns false if it was already settled. */
  finishJobItem(orgId: string, jobId: string, itemId: string, patch: Partial<Pick<BulkJobItem, "status" | "errorCode" | "retryable" | "completedAt">>): Promise<boolean>;
  /** Atomically cancel all queued items; returns the cancelled items (caller settles their holds). */
  cancelQueuedItems(orgId: string, jobId: string): Promise<BulkJobItem[]>;
  /** processing items claimed before `olderThanIso` go back to queued (crash recovery). Returns count. */
  requeueStaleItems(orgId: string, jobId: string, olderThanIso: string, maxAttempts: number): Promise<{ requeued: number; failed: BulkJobItem[] }>;
  /** Reset failed+retryable items to queued with a fresh hold flag. Returns the items. */
  requeueFailedItems(orgId: string, jobId: string): Promise<BulkJobItem[]>;
  // ---- imports
  putImport(orgId: string, rec: ImportRecord, chunks?: ImportRowData[][]): Promise<void>;
  getImport(orgId: string, id: string): Promise<ImportRecord | null>;
  listImports(orgId: string, limit: number): Promise<ImportRecord[]>;
  /** Atomic counter update (+ optional patch and appended failed rows, capped). The ONLY way import counters change. */
  incrementImport(orgId: string, id: string, d: ImportDeltas, patch?: Partial<Pick<ImportRecord, "status" | "startedAt" | "completedAt" | "nextChunk" | "verify" | "errorCode">>, addFailed?: ImportFailedRow[]): Promise<ImportRecord | null>;
  getImportChunk(orgId: string, id: string, index: number): Promise<ImportRowData[] | null>;
  /** Atomically map an idempotency key to a job. Returns the EXISTING job id if the key was already claimed. */
  claimIdempotency(orgId: string, key: string, jobId: string, fingerprint: string, nowIso: string): Promise<{ jobId: string; fingerprint: string; createdAt: string } | null>;
  /** Compare-and-delete: removes the key only if it still points at `ifJobId` (so nobody deletes a re-taken claim). */
  releaseIdempotency(orgId: string, key: string, ifJobId: string): Promise<void>;
}
