import { MemoryUsageStore } from "@/lib/usage";
import { decodeCursor, encodeCursor } from "@/lib/pagination";
import { clientGstins, clientHasGstin } from "@/lib/client-gstins";
import type { NormalizedReturn } from "@/lib/returns";
import type {
  Concern, ConcernStatus, Alert, AuditEntry, BulkJob, BulkJobItem, CheckEntry, Client, GstinFilter, GstinRecord, GstinSort, ImportDeltas, ImportFailedRow,
  ImportRecord, ImportRowData, Invitation, JobDeltas, JobItemStatus, Member, Organization, Page, ReturnFilter, Store, UserProfile, VerificationRecord, CostCounters, SharedResult,
} from "./types";

interface OrgBucket {
  org: Organization;
  members: Map<string, Member>;
  clients: Map<string, Client>;
  gstins: Map<string, GstinRecord>;
  returns: Map<string, NormalizedReturn>;
  checks: CheckEntry[];
  verifications: Map<string, VerificationRecord>;
  concerns: Map<string, Concern>;
  audit: AuditEntry[];
  alerts: Alert[];
  jobs: Map<string, BulkJob>;
  items: Map<string, Map<string, BulkJobItem>>;
  idem: Map<string, { jobId: string; fingerprint: string; createdAt: string }>;
  imports: Map<string, ImportRecord>;
  importChunks: Map<string, ImportRowData[][]>;
}

export const ZERO_COST: CostCounters = { searches: 0, paidCalls: 0, cacheHits: 0, sharedHits: 0, cacheMisses: 0, deduped: 0, failures: 0, credits: 0 };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function matchGstin(r: GstinRecord, f: GstinFilter): boolean {
  if ((f.archived === true) !== (r.archived === true)) return false; // archived records appear only when explicitly asked for
  if (f.status && r.status !== f.status) return false;
  if (f.indicators && !(r.indicator && f.indicators.includes(r.indicator))) return false;
  if (f.checked !== undefined && !!r.lastCheckedAt !== f.checked) return false;
  if (f.refreshBefore && !(r.lastCheckedAt && r.cacheExpiresAt && r.cacheExpiresAt <= f.refreshBefore)) return false;
  if (f.gstr1Missing === "none" && r.gstr1Missing !== 0) return false;
  if (f.gstr1Missing === "some" && !((r.gstr1Missing ?? 0) > 0)) return false;
  if (f.gstr3bMissing === "none" && r.gstr3bMissing !== 0) return false;
  if (f.gstr3bMissing === "some" && !((r.gstr3bMissing ?? 0) > 0)) return false;
  if (f.gstr1Late && !((r.gstr1Late ?? 0) > 0)) return false;
  if (f.gstr3bLate && !((r.gstr3bLate ?? 0) > 0)) return false;
  if (f.assignedTo && r.assignedTo !== f.assignedTo) return false;
  if (f.search) {
    const q = f.search.trim();
    if (!(r.gstin.startsWith(q.toUpperCase()) || (r.clientName ?? "").toLowerCase().startsWith(q.toLowerCase()))) return false;
  }
  return true;
}

/** Generic keyset pagination over an already-filtered array. */
function paginate<T>(
  all: T[], key: (t: T) => string, id: (t: T) => string, dir: "asc" | "desc", limit: number, cursor?: string,
): Page<T> {
  const sorted = [...all].sort((a, b) => (cmp(key(a), key(b)) || cmp(id(a), id(b))) * (dir === "asc" ? 1 : -1));
  const c = decodeCursor<{ v: string; id: string }>(cursor);
  const start = c
    ? sorted.findIndex((t) => (cmp(key(t), c.v) || cmp(id(t), c.id)) * (dir === "asc" ? 1 : -1) > 0)
    : 0;
  if (start < 0) return { items: [] };
  const items = sorted.slice(start, start + limit);
  const more = start + limit < sorted.length;
  const last = items[items.length - 1];
  return { items, nextCursor: more && last ? encodeCursor({ v: key(last), id: id(last) }) : undefined };
}

/** In-memory Store for development and tests ONLY. */
export class MemoryStore implements Store {
  usage = new MemoryUsageStore();
  private orgs = new Map<string, OrgBucket>();
  private users = new Map<string, UserProfile>();
  private invitations = new Map<string, Invitation>();
  private costs = new Map<string, CostCounters>();
  private shared = new Map<string, SharedResult>();

  private b(orgId: string): OrgBucket {
    const b = this.orgs.get(orgId);
    if (!b) throw new Error("ORG_NOT_FOUND");
    return b;
  }

  async createOrg(org: Organization, owner: Member) {
    if (this.orgs.has(org.id)) throw new Error("ORG_EXISTS");
    this.orgs.set(org.id, {
      org: { ...org }, members: new Map([[owner.uid, { ...owner }]]), clients: new Map(), gstins: new Map(),
      returns: new Map(), checks: [], verifications: new Map(), concerns: new Map(), audit: [], alerts: [], jobs: new Map(), items: new Map(), idem: new Map(), imports: new Map(), importChunks: new Map(),
    });
  }
  async getOrg(orgId: string) { const b = this.orgs.get(orgId); return b ? { ...b.org } : null; }
  async updateOrg(orgId: string, patch: Partial<Organization>) { Object.assign(this.b(orgId).org, patch, { id: orgId }); }
  async putUser(u: UserProfile) { this.users.set(u.uid, { ...u }); }
  async getUser(uid: string) { const u = this.users.get(uid); return u ? { ...u } : null; }
  async listMemberships(uid: string) {
    const out: { organization: Organization; member: Member }[] = [];
    for (const b of this.orgs.values()) {
      const m = b.members.get(uid);
      if (m) out.push({ organization: { ...b.org }, member: { ...m } });
    }
    return out;
  }
  async putInvitation(i: Invitation) { this.b(i.organizationId); this.invitations.set(i.id, { ...i }); }
  async getInvitation(tokenHash: string) { const i = this.invitations.get(tokenHash); return i ? { ...i } : null; }
  async listInvitations(orgId: string) { return [...this.invitations.values()].filter((i) => i.organizationId === orgId).map((i) => ({ ...i })); }

  async findMembership(uid: string) {
    for (const [organizationId, b] of this.orgs) {
      const m = b.members.get(uid);
      if (m) return { organizationId, member: { ...m } };
    }
    return null;
  }
  async getMember(orgId: string, uid: string) { const m = this.b(orgId).members.get(uid); return m ? { ...m } : null; }
  async listMembers(orgId: string) { return [...this.b(orgId).members.values()].map((m) => ({ ...m })); }
  async putMember(orgId: string, m: Member) { this.b(orgId).members.set(m.uid, { ...m }); }
  async removeMember(orgId: string, uid: string) { this.b(orgId).members.delete(uid); }

  async createClient(orgId: string, c: Client) {
    const b = this.b(orgId);
    if (b.clients.has(c.id)) throw new Error("CLIENT_EXISTS");
    b.clients.set(c.id, { ...c });
  }
  async getClient(orgId: string, id: string) { const c = this.b(orgId).clients.get(id); return c ? { ...c } : null; }
  async getClientsByIds(orgId: string, ids: string[]) {
    const b = this.b(orgId);
    return ids.flatMap((id) => { const c = b.clients.get(id); return c ? [{ ...c }] : []; });
  }
  async updateClient(orgId: string, id: string, patch: Partial<Client>) {
    const c = this.b(orgId).clients.get(id);
    if (!c) throw new Error("CLIENT_NOT_FOUND");
    Object.assign(c, patch, { id });
  }
  async deleteClient(orgId: string, id: string) { this.b(orgId).clients.delete(id); }
  async listClients(orgId: string, o: { limit: number; cursor?: string; search?: string; status?: "active" | "archived" | "all" }): Promise<Page<Client>> {
    const q = o.search?.trim().toLowerCase();
    const want = o.status ?? "active";
    const all = [...this.b(orgId).clients.values()]
      .filter((c) => want === "all" || (want === "archived" ? c.status === "archived" : c.status !== "archived"))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || clientGstins(c).some((g) => g.toLowerCase().includes(q)))
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = o.cursor ? all.findIndex((c) => c.id > o.cursor!) : 0;
    if (start < 0) return { items: [] };
    const items = all.slice(start, start + o.limit);
    const more = start + o.limit < all.length;
    return { items: items.map((c) => ({ ...c })), nextCursor: more ? items[items.length - 1].id : undefined };
  }
  async countClients(orgId: string, status: "active" | "archived" = "active") {
    let n = 0;
    for (const c of this.b(orgId).clients.values()) if ((c.status === "archived") === (status === "archived")) n++;
    return n;
  }
  async allGstins(orgId: string) { return new Set([...this.b(orgId).clients.values()].flatMap((c) => clientGstins(c))); }
  async findClientByGstin(orgId: string, gstin: string) {
    for (const c of this.b(orgId).clients.values()) if (clientHasGstin(c, gstin)) return { ...c, gstins: c.gstins && [...c.gstins] };
    return null;
  }

  async getGstinRecord(orgId: string, gstin: string) { const r = this.b(orgId).gstins.get(gstin); return r ? { ...r } : null; }
  async getGstinRecords(orgId: string, gstins: string[]) {
    const b = this.b(orgId);
    return gstins.flatMap((g) => { const r = b.gstins.get(g); return r ? [{ ...r }] : []; });
  }
  async putGstinRecord(orgId: string, r: GstinRecord) { this.b(orgId).gstins.set(r.gstin, { ...r }); }
  async deleteGstinData(orgId: string, gstin: string) {
    const b = this.b(orgId);
    b.gstins.delete(gstin);
    for (const [id, r] of b.returns) if (r.gstin === gstin) b.returns.delete(id);
  }
  async listGstins(orgId: string, f: GstinFilter, o: { limit: number; cursor?: string; sort: GstinSort }): Promise<Page<GstinRecord>> {
    let all = [...this.b(orgId).gstins.values()].filter((r) => matchGstin(r, f));
    // Parity with Firestore: ordering by a field excludes documents that do not have it.
    if (o.sort.by === "lastCheckedAt") all = all.filter((r) => !!r.lastCheckedAt);
    const key = (r: GstinRecord) => (o.sort.by === "gstin" ? r.gstin : r.lastCheckedAt ?? "");
    const p = paginate(all, key, (r) => r.gstin, o.sort.dir, o.limit, o.cursor);
    return { items: p.items.map((r) => ({ ...r })), nextCursor: p.nextCursor };
  }
  async countGstins(orgId: string, f: GstinFilter) {
    return [...this.b(orgId).gstins.values()].filter((r) => matchGstin(r, { ...f, search: undefined })).length;
  }

  async putReturns(orgId: string, _gstin: string, records: NormalizedReturn[]) {
    void _gstin;
    const m = this.b(orgId).returns;
    for (const r of records) m.set(r.id, { ...r });
  }
  async listReturns(orgId: string, gstin: string) {
    return [...this.b(orgId).returns.values()].filter((r) => r.gstin === gstin).sort((a, b) => cmp(a.id, b.id)).map((r) => ({ ...r }));
  }
  async queryReturns(orgId: string, f: ReturnFilter, o: { limit: number; cursor?: string; dir: "asc" | "desc" }): Promise<Page<NormalizedReturn>> {
    const useDue = !!(f.dueFrom || f.dueTo), useFiled = !!(f.filedFrom || f.filedTo);
    let all = [...this.b(orgId).returns.values()].filter((r) =>
      (!f.gstin || r.gstin === f.gstin) && (!f.returnType || r.returnType === f.returnType) &&
      (!f.financialYear || r.financialYear === f.financialYear) && (!f.period || r.period === f.period) &&
      (!f.state || r.state === f.state) && (!f.status || r.status === f.status) &&
      (!f.dueFrom || r.dueDate >= f.dueFrom) && (!f.dueTo || r.dueDate <= f.dueTo) &&
      (!f.filedFrom || (!!r.filingDate && r.filingDate >= f.filedFrom)) && (!f.filedTo || (!!r.filingDate && r.filingDate <= f.filedTo)));
    if (useFiled) all = all.filter((r) => !!r.filingDate);
    const key = (r: NormalizedReturn) => (useDue ? r.dueDate : useFiled ? r.filingDate ?? "" : r.id);
    const p = paginate(all, key, (r) => r.id, o.dir, o.limit, o.cursor);
    return { items: p.items.map((r) => ({ ...r })), nextCursor: p.nextCursor };
  }

  async listDueClients(beforeIso: string, limit: number) {
    const out: { orgId: string; clientId: string; gstin: string; nextVerifyAt: string }[] = [];
    for (const [orgId, b] of this.orgs) for (const c of b.clients.values()) {
      if (c.status === "active" && c.verifySchedule && c.nextVerifyAt && c.nextVerifyAt <= beforeIso) out.push({ orgId, clientId: c.id, gstin: c.gstin, nextVerifyAt: c.nextVerifyAt });
    }
    return out.sort((a, b) => cmp(a.nextVerifyAt, b.nextVerifyAt) || cmp(a.clientId, b.clientId)).slice(0, limit);
  }
  async getVerification(orgId: string, gstin: string) { const r = this.b(orgId).verifications.get(gstin); return r ? { ...r, details: r.details && { ...r.details } } : null; }
  async getVerifications(orgId: string, gstins: string[]) {
    const b = this.b(orgId); const out: VerificationRecord[] = [];
    for (const g of new Set(gstins)) { const r = b.verifications.get(g); if (r) out.push({ ...r, details: r.details && { ...r.details } }); }
    return out;
  }
  async putVerification(orgId: string, r: VerificationRecord) { this.b(orgId).verifications.set(r.gstin, { ...r, details: r.details && { ...r.details } }); }
  async listVerifications(orgId: string, limit: number, o: { saved?: boolean; tag?: string } = {}) {
    return [...this.b(orgId).verifications.values()].filter((r) => !o.saved || r.saved === true).filter((r) => !o.tag || (r.tags ?? []).includes(o.tag)).sort((a, b) => cmp(b.verifiedAt, a.verifiedAt) || cmp(a.gstin, b.gstin)).slice(0, limit).map((r) => ({ ...r }));
  }
  async bumpCost(scope: string, period: string, d: Partial<CostCounters>) {
    const k = `${scope}|${period}`; const c = this.costs.get(k) ?? { ...ZERO_COST };
    for (const f of Object.keys(ZERO_COST) as (keyof CostCounters)[]) c[f] += d[f] ?? 0;
    this.costs.set(k, c);
  }
  async getCost(scope: string, period: string) { return { ...(this.costs.get(`${scope}|${period}`) ?? ZERO_COST) }; }
  async getSharedResult(gstin: string) { const r = this.shared.get(gstin); return r ? { ...r, details: r.details && { ...r.details } } : null; }
  async putSharedResult(r: SharedResult) { this.shared.set(r.gstin, { ...r, details: r.details && { ...r.details } }); }
  async deleteVerification(orgId: string, gstin: string) { this.b(orgId).verifications.delete(gstin); }
  async createConcern(orgId: string, c: Concern) { this.b(orgId).concerns.set(c.id, { ...c, snapshot: c.snapshot && { ...c.snapshot } }); }
  async getConcern(orgId: string, id: string) { const c = this.b(orgId).concerns.get(id); return c ? { ...c, snapshot: c.snapshot && { ...c.snapshot } } : null; }
  async listConcerns(orgId: string, o: { limit: number; status?: ConcernStatus; gstin?: string }) {
    return [...this.b(orgId).concerns.values()].filter((c) => (!o.status || c.status === o.status) && (!o.gstin || c.gstin === o.gstin))
      .sort((a, b) => cmp(b.createdAt, a.createdAt) || cmp(a.id, b.id)).slice(0, o.limit).map((c) => ({ ...c }));
  }
  async updateConcern(orgId: string, id: string, patch: Partial<Pick<Concern, "status" | "resolution" | "reviewedBy" | "updatedAt">>) {
    const c = this.b(orgId).concerns.get(id); if (!c) return null;
    Object.assign(c, patch); return { ...c };
  }
  async addCheck(orgId: string, c: CheckEntry) { this.b(orgId).checks.push({ ...c }); }
  async listChecks(orgId: string, limit: number) { return this.b(orgId).checks.slice(-limit).reverse(); }
  async addAudit(e: AuditEntry) { this.b(e.organizationId).audit.push({ ...e }); }
  async listAudit(orgId: string, limit: number) { return this.b(orgId).audit.slice(-limit).reverse(); }
  async addAlert(orgId: string, a: Alert) { const l = this.b(orgId).alerts; const i = l.findIndex((x) => x.id === a.id); if (i >= 0) l[i] = { ...a }; else l.push({ ...a }); }
  async listAlerts(orgId: string, limit: number, o: { unread?: boolean } = {}) {
    return [...this.b(orgId).alerts].filter((a) => !o.unread || !a.read).sort((x, y) => cmp(y.at, x.at) || cmp(y.id, x.id)).slice(0, limit).map((a) => ({ ...a }));
  }
  async markAlerts(orgId: string, o: { ids?: string[]; all?: boolean }, read: boolean) {
    const want = o.all ? null : new Set(o.ids ?? []); let n = 0;
    for (const a of this.b(orgId).alerts) if ((!want || want.has(a.id)) && a.read !== read) { a.read = read; n++; }
    return n;
  }
  async countUnreadAlerts(orgId: string) { return this.b(orgId).alerts.filter((a) => !a.read).length; }

  // ---- bulk jobs (every mutation is one synchronous section => atomic in a single process) ----------
  private job(orgId: string, id: string): BulkJob | undefined { return this.b(orgId).jobs.get(id); }
  private itemMap(orgId: string, jobId: string) { return this.b(orgId).items.get(jobId); }

  async createJob(orgId: string, job: BulkJob, items: BulkJobItem[]) {
    const b = this.b(orgId);
    if (job.organizationId !== orgId) throw new Error("ORG_MISMATCH");
    b.jobs.set(job.id, structuredClone(job));
    b.items.set(job.id, new Map(items.map((i) => [i.id, { ...i }])));
  }
  async getJob(orgId: string, id: string) { const j = this.job(orgId, id); return j ? structuredClone(j) : null; }
  async listJobs(orgId: string, limit: number) {
    return [...this.b(orgId).jobs.values()].sort((a, b) => cmp(b.createdAt, a.createdAt)).slice(0, limit).map((j) => structuredClone(j));
  }
  async incrementJob(orgId: string, id: string, d: JobDeltas, patch: Partial<BulkJob> = {}) {
    const j = this.job(orgId, id);
    if (!j) return null;
    for (const k of ["queued", "processing", "succeeded", "cached", "failed", "cancelled"] as const) j.counts[k] += d[k] ?? 0;
    j.quota.consumed += d.consumed ?? 0;
    j.quota.released += d.released ?? 0;
    j.quota.reserved += d.reserved ?? 0;
    j.skipped += d.skipped ?? 0;
    Object.assign(j, patch);
    return structuredClone(j);
  }
  async listJobItems(orgId: string, jobId: string, o: { status?: JobItemStatus; limit: number; cursor?: string }): Promise<Page<BulkJobItem>> {
    const m = this.itemMap(orgId, jobId);
    if (!m) return { items: [] };
    const all = [...m.values()].filter((i) => !o.status || i.status === o.status);
    const p = paginate(all, (i) => i.id, (i) => i.id, "asc", o.limit, o.cursor);
    return { items: p.items.map((i) => ({ ...i })), nextCursor: p.nextCursor };
  }
  async claimJobItems(orgId: string, jobId: string, n: number, nowIso: string) {
    const j = this.job(orgId, jobId), m = this.itemMap(orgId, jobId);
    if (!j || !m) return [];
    const out: BulkJobItem[] = [];
    for (const it of m.values()) {
      if (out.length >= n) break;
      if (it.status !== "queued") continue;
      it.status = "processing"; it.attempts += 1; it.claimedAt = nowIso;
      out.push({ ...it });
    }
    j.counts.queued -= out.length; j.counts.processing += out.length;
    if (out.length && (j.status === "queued" || !j.startedAt)) { j.status = "running"; j.startedAt ??= nowIso; }
    return out;
  }
  async finishJobItem(orgId: string, jobId: string, itemId: string, patch: Partial<BulkJobItem>) {
    const j = this.job(orgId, jobId), it = this.itemMap(orgId, jobId)?.get(itemId);
    if (!j || !it || it.settled || it.status !== "processing") return false;
    Object.assign(it, patch, { settled: true });
    j.counts.processing -= 1;
    j.counts[it.status as "succeeded" | "cached" | "failed" | "cancelled"] += 1;
    return true;
  }
  async cancelQueuedItems(orgId: string, jobId: string) {
    const j = this.job(orgId, jobId), m = this.itemMap(orgId, jobId);
    if (!j || !m) return [];
    const out: BulkJobItem[] = [];
    for (const it of m.values()) {
      if (it.status !== "queued") continue;
      it.status = "cancelled"; it.settled = true;
      out.push({ ...it, status: "cancelled" });
    }
    j.counts.queued -= out.length; j.counts.cancelled += out.length;
    return out;
  }
  async requeueStaleItems(orgId: string, jobId: string, olderThanIso: string, maxAttempts: number) {
    const j = this.job(orgId, jobId), m = this.itemMap(orgId, jobId);
    if (!j || !m) return { requeued: 0, failed: [] };
    let requeued = 0;
    const failed: BulkJobItem[] = [];
    for (const it of m.values()) {
      if (it.status !== "processing" || !it.claimedAt || it.claimedAt >= olderThanIso) continue;
      if (it.attempts >= maxAttempts) {
        it.status = "failed"; it.settled = true; it.errorCode = "WORKER_TIMEOUT"; it.retryable = true;
        j.counts.processing -= 1; j.counts.failed += 1; failed.push({ ...it });
      } else { it.status = "queued"; j.counts.processing -= 1; j.counts.queued += 1; requeued++; }
    }
    return { requeued, failed };
  }
  async requeueFailedItems(orgId: string, jobId: string) {
    const j = this.job(orgId, jobId), m = this.itemMap(orgId, jobId);
    if (!j || !m) return [];
    const out: BulkJobItem[] = [];
    for (const it of m.values()) {
      if (it.status !== "failed" || !it.retryable) continue;
      it.status = "queued"; it.settled = false; it.held = false; it.errorCode = undefined; it.retryable = undefined; it.completedAt = undefined;
      out.push({ ...it });
    }
    j.counts.failed -= out.length; j.counts.queued += out.length;
    if (out.length) { j.status = "queued"; j.completedAt = undefined; }
    return out;
  }
  async putImport(orgId: string, rec: ImportRecord, chunks?: ImportRowData[][]) {
    const b = this.b(orgId);
    if (rec.organizationId !== orgId) throw new Error("ORG_MISMATCH");
    if (chunks) b.importChunks.set(rec.id, structuredClone(chunks)); // chunks first, record last (record = visible)
    b.imports.set(rec.id, structuredClone(rec));
  }
  async getImport(orgId: string, id: string) { const r = this.b(orgId).imports.get(id); return r ? structuredClone(r) : null; }
  async listImports(orgId: string, limit: number) {
    return [...this.b(orgId).imports.values()].sort((a, b) => cmp(b.createdAt, a.createdAt)).slice(0, limit).map((r) => structuredClone(r));
  }
  async incrementImport(orgId: string, id: string, d: ImportDeltas, patch: Partial<ImportRecord> = {}, addFailed: ImportFailedRow[] = []) {
    const r = this.b(orgId).imports.get(id);
    if (!r) return null;
    r.counts.imported += d.imported ?? 0; r.counts.failedToCreate += d.failedToCreate ?? 0; r.counts.skippedPlanLimit += d.skippedPlanLimit ?? 0;
    r.processed += d.processed ?? 0;
    for (const f of addFailed) { if (r.failedRows.length < 1000) r.failedRows.push({ ...f }); else r.failedRowsTruncated = true; }
    Object.assign(r, patch);
    return structuredClone(r);
  }
  async getImportChunk(orgId: string, id: string, index: number) {
    const c = this.b(orgId).importChunks.get(id)?.[index];
    return c ? structuredClone(c) : null;
  }
  async claimIdempotency(orgId: string, key: string, jobId: string, fingerprint: string, nowIso: string) {
    const b = this.b(orgId);
    const ex = b.idem.get(key);
    if (ex) return { ...ex };
    b.idem.set(key, { jobId, fingerprint, createdAt: nowIso });
    return null;
  }
  async releaseIdempotency(orgId: string, key: string, ifJobId: string) {
    const b = this.b(orgId);
    if (b.idem.get(key)?.jobId === ifJobId) b.idem.delete(key);
  }
}
