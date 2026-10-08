// SERVER ONLY. Firestore implementation of Store.
//
// ⚠️ UNVERIFIED AGAINST A LIVE FIRESTORE: no emulator (Java missing) and no project credentials were
// available when this was written. It type-checks and follows DATABASE_API.md, but must be exercised
// against the Firebase emulator / a real project before production use (see README → Blocked).
// Composite indexes needed by some filter/sort combinations are NOT yet generated (see README tech debt).
import { FieldPath, FieldValue, type DocumentData, type Firestore, type Query } from "firebase-admin/firestore";
import type { PlanId } from "@/config/plans";
import { decodeCursor, encodeCursor } from "@/lib/pagination";
import type { NormalizedReturn } from "@/lib/returns";
import type { UsageDoc, UsageStore } from "@/lib/usage";
import { matchGstin, ZERO_COST } from "./memory";
import type {
  Concern, ConcernStatus, Alert, AuditEntry, BulkJob, BulkJobItem, CheckEntry, Client, GstinFilter, GstinRecord, GstinSort, ImportDeltas, ImportFailedRow,
  ImportRecord, ImportRowData, Invitation, JobDeltas, JobItemStatus, Member, Organization, Page, ReturnFilter, Store, UserProfile, VerificationRecord, CostCounters, SharedResult,
} from "./types";

const strip = <T,>(d: DocumentData | undefined): T | null => {
  if (!d) return null;
  const { nameLower: _a, clientNameLower: _b, ...rest } = d as DocumentData;
  void _a; void _b;
  return rest as T;
};
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const COUNT_KEYS = ["queued", "processing", "succeeded", "cached", "failed", "cancelled"] as const;

export class FirestoreUsageStore implements UsageStore {
  constructor(private db: Firestore) {}
  private ref(orgId: string, month: string) { return this.db.doc(`organizations/${orgId}/usage/${month}`); }
  private norm(d: Partial<UsageDoc> | undefined) { return { used: d?.used ?? 0, reserved: d?.reserved ?? 0, cachedChecks: d?.cachedChecks ?? 0, failedRequests: d?.failedRequests ?? 0 }; }

  /** Transactional check-and-increment: concurrent workers can never exceed the limit. */
  async reserve(orgId: string, month: string, plan: PlanId, limit: number | null, n: number) {
    const ref = this.ref(orgId, month);
    return this.db.runTransaction(async (tx) => {
      const cur = this.norm((await tx.get(ref)).data() as Partial<UsageDoc> | undefined);
      if (limit !== null && cur.used + cur.reserved + n > limit) return { ok: false, used: cur.used };
      tx.set(ref, { organizationId: orgId, month, plan, limit, ...cur, used: cur.used + n }, { merge: true });
      return { ok: true, used: cur.used + n };
    });
  }
  async hold(orgId: string, month: string, plan: PlanId, limit: number | null, n: number, allowPartial: boolean) {
    const ref = this.ref(orgId, month);
    return this.db.runTransaction(async (tx) => {
      const cur = this.norm((await tx.get(ref)).data() as Partial<UsageDoc> | undefined);
      const free = limit === null ? n : Math.max(0, limit - cur.used - cur.reserved);
      const held = allowPartial ? Math.min(n, free) : free >= n ? n : 0;
      if (held <= 0 && n > 0) return { ok: false, held: 0 };
      tx.set(ref, { organizationId: orgId, month, plan, limit, ...cur, reserved: cur.reserved + held }, { merge: true });
      return { ok: true, held };
    });
  }
  async settle(orgId: string, month: string, consume: number, release: number) {
    const ref = this.ref(orgId, month);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const cur = this.norm(snap.data() as Partial<UsageDoc>);
      const total = Math.min(cur.reserved, consume + release);
      tx.update(ref, { reserved: cur.reserved - total, used: cur.used + Math.min(consume, total) });
    });
  }
  async release(orgId: string, month: string, n: number) {
    const ref = this.ref(orgId, month);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      tx.update(ref, { used: Math.max(0, this.norm(snap.data() as Partial<UsageDoc>).used - n) });
    });
  }
  async bump(orgId: string, month: string, field: "cachedChecks" | "failedRequests", n: number) {
    const ref = this.ref(orgId, month);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      tx.update(ref, { [field]: this.norm(snap.data() as Partial<UsageDoc>)[field] + n });
    });
  }
  async get(orgId: string, month: string) {
    const d = (await this.ref(orgId, month).get()).data() as UsageDoc | undefined;
    return d ? { ...d, reserved: d.reserved ?? 0 } : null;
  }
}

export class FirestoreStore implements Store {
  usage: UsageStore;
  constructor(private db: Firestore) { this.usage = new FirestoreUsageStore(db); }

  private org = (id: string) => this.db.doc(`organizations/${id}`);
  private col = (orgId: string, name: string) => this.db.collection(`organizations/${orgId}/${name}`);
  private mirror = (uid: string, orgId: string) => this.db.doc(`users/${uid}/memberships/${orgId}`);
  private jobRef = (orgId: string, id: string) => this.col(orgId, "jobs").doc(id);
  private itemsCol = (orgId: string, jobId: string) => this.jobRef(orgId, jobId).collection("items");

  async createOrg(org: Organization, owner: Member) {
    const b = this.db.batch();
    b.create(this.org(org.id), org as unknown as DocumentData);
    b.set(this.org(org.id).collection("members").doc(owner.uid), owner as unknown as DocumentData);
    b.set(this.mirror(owner.uid, org.id), { organizationId: org.id, role: owner.role });
    await b.commit();
  }
  async getOrg(id: string) { return strip<Organization>((await this.org(id).get()).data()); }
  async updateOrg(id: string, patch: Partial<Organization>) { await this.org(id).update({ ...patch } as DocumentData); }

  async putUser(u: UserProfile) { await this.db.doc(`users/${u.uid}`).set(u as unknown as DocumentData, { merge: true }); }
  async getUser(uid: string) { return strip<UserProfile>((await this.db.doc(`users/${uid}`).get()).data()); }

  async listMemberships(uid: string) {
    const ms = await this.db.collection(`users/${uid}/memberships`).get();
    const out: { organization: Organization; member: Member }[] = [];
    await Promise.all(ms.docs.map(async (d) => {
      const [o, m] = await Promise.all([this.getOrg(d.id), this.getMember(d.id, uid)]);
      if (o && m) out.push({ organization: o, member: m });
    }));
    return out;
  }
  async findMembership(uid: string) {
    const all = await this.listMemberships(uid);
    return all[0] ? { organizationId: all[0].organization.id, member: all[0].member } : null;
  }
  async getMember(orgId: string, uid: string) { return strip<Member>((await this.col(orgId, "members").doc(uid).get()).data()); }
  async listMembers(orgId: string) { return (await this.col(orgId, "members").get()).docs.map((d) => d.data() as Member); }
  async putMember(orgId: string, m: Member) {
    const b = this.db.batch();
    b.set(this.col(orgId, "members").doc(m.uid), m as unknown as DocumentData);
    b.set(this.mirror(m.uid, orgId), { organizationId: orgId, role: m.role });
    await b.commit();
  }
  async removeMember(orgId: string, uid: string) {
    const b = this.db.batch();
    b.delete(this.col(orgId, "members").doc(uid));
    b.delete(this.mirror(uid, orgId));
    await b.commit();
  }

  // Invitations are keyed by token hash for O(1) lookup without a collection-group index.
  async putInvitation(i: Invitation) { await this.db.doc(`invitations/${i.id}`).set(i as unknown as DocumentData); }
  async getInvitation(hash: string) { return strip<Invitation>((await this.db.doc(`invitations/${hash}`).get()).data()); }
  async listInvitations(orgId: string) {
    return (await this.db.collection("invitations").where("organizationId", "==", orgId).get()).docs.map((d) => d.data() as Invitation);
  }

  async createClient(orgId: string, c: Client) {
    await this.col(orgId, "clients").doc(c.id).create({ ...c, nameLower: c.name.toLowerCase() } as DocumentData);
  }
  async getClient(orgId: string, id: string) { return strip<Client>((await this.col(orgId, "clients").doc(id).get()).data()); }
  async getClientsByIds(orgId: string, ids: string[]) {
    const out: Client[] = [];
    for (const part of chunks(ids, 300)) {
      if (!part.length) continue;
      const snaps = await this.db.getAll(...part.map((id) => this.col(orgId, "clients").doc(id)));
      for (const s of snaps) if (s.exists) out.push(strip<Client>(s.data())!);
    }
    return out;
  }
  async updateClient(orgId: string, id: string, patch: Partial<Client>) {
    const p: DocumentData = { ...patch };
    delete p.id;
    if (patch.name) p.nameLower = patch.name.toLowerCase();
    // ignoreUndefinedProperties would silently keep these; an explicit undefined means "clear the schedule".
    for (const k of ["verifySchedule", "nextVerifyAt"] as const) if (k in patch && patch[k] === undefined) p[k] = FieldValue.delete();
    await this.col(orgId, "clients").doc(id).update(p);
  }
  async deleteClient(orgId: string, id: string) { await this.col(orgId, "clients").doc(id).delete(); }

  /**
   * Without search: cursor pagination by document id.
   * With search: prefix match on lower-cased name OR GSTIN, merged, single page (no cursor).
   */
  async listClients(orgId: string, o: { limit: number; cursor?: string; search?: string; status?: "active" | "archived" | "all" }): Promise<Page<Client>> {
    const want = o.status ?? "active";
    // UNVERIFIED: a status equality alongside orderBy/startAt needs composite indexes that are not generated.
    const c: Query = want === "all" ? this.col(orgId, "clients") : this.col(orgId, "clients").where("status", "==", want);
    const q = o.search?.trim();
    if (q) {
      const lo = q.toLowerCase(), up = q.toUpperCase();
      const [byName, byGstin] = await Promise.all([
        c.orderBy("nameLower").startAt(lo).endAt(lo + "").limit(o.limit).get(),
        c.orderBy("gstin").startAt(up).endAt(up + "").limit(o.limit).get(),
      ]);
      const seen = new Map<string, Client>();
      for (const d of [...byName.docs, ...byGstin.docs]) seen.set(d.id, strip<Client>(d.data())!);
      return { items: [...seen.values()].slice(0, o.limit) };
    }
    let query = c.orderBy(FieldPath.documentId());
    if (o.cursor) query = query.startAfter(o.cursor);
    const snap = await query.limit(o.limit + 1).get();
    const docs = snap.docs.slice(0, o.limit);
    return { items: docs.map((d) => strip<Client>(d.data())!), nextCursor: snap.docs.length > o.limit ? docs[docs.length - 1].id : undefined };
  }
  async countClients(orgId: string, status: "active" | "archived" = "active") { return (await this.col(orgId, "clients").where("status", "==", status).count().get()).data().count; }
  async allGstins(orgId: string) {
    const snap = await this.col(orgId, "clients").select("gstin", "gstins").get();
    return new Set(snap.docs.flatMap((d) => [d.get("gstin") as string, ...((d.get("gstins") as string[] | undefined) ?? [])]));
  }
  async findClientByGstin(orgId: string, gstin: string) {
    const col = this.col(orgId, "clients");
    const snap = await col.where("gstin", "==", gstin).limit(1).get();
    if (!snap.empty) return strip<Client>(snap.docs[0].data());
    // Additional GSTINs live in the `gstins` array (UNVERIFIED: array-contains on a clients subcollection; no emulator was available).
    const more = await col.where("gstins", "array-contains", gstin).limit(1).get();
    return more.empty ? null : strip<Client>(more.docs[0].data());
  }

  // ---- GSTIN records ----------------------------------------------------------------------------
  async getGstinRecord(orgId: string, gstin: string) { return strip<GstinRecord>((await this.col(orgId, "gstins").doc(gstin).get()).data()); }
  async getGstinRecords(orgId: string, gstins: string[]) {
    const out: GstinRecord[] = [];
    for (const part of chunks([...new Set(gstins)], 300)) {
      if (!part.length) continue;
      const snaps = await this.db.getAll(...part.map((g) => this.col(orgId, "gstins").doc(g)));
      for (const s of snaps) if (s.exists) out.push(strip<GstinRecord>(s.data())!);
    }
    return out;
  }
  async putGstinRecord(orgId: string, r: GstinRecord) {
    // `archived` is always written as a boolean so "not archived" is an indexable equality filter (see gstinQuery).
    await this.col(orgId, "gstins").doc(r.gstin).set({ ...r, archived: r.archived === true, clientNameLower: r.clientName?.toLowerCase() } as DocumentData);
  }

  async deleteGstinData(orgId: string, gstin: string) {
    const rets = await this.col(orgId, "returns").where("gstin", "==", gstin).get();
    for (const part of chunks(rets.docs, 400)) {
      const b = this.db.batch();
      for (const d of part) b.delete(d.ref);
      await b.commit();
    }
    await this.col(orgId, "gstins").doc(gstin).delete();
  }

  /** Equality/inequality filters map 1:1 to indexed fields. Some combinations need composite indexes (not yet generated). */
  private gstinQuery(orgId: string, f: GstinFilter): Query {
    let q: Query = this.col(orgId, "gstins");
    // UNVERIFIED: every filter combination now also carries this equality, so composite indexes need `archived` added. Records written before this field existed would not match.
    q = q.where("archived", "==", f.archived === true);
    if (f.status) q = q.where("status", "==", f.status);
    if (f.indicators?.length) q = q.where("indicator", "in", f.indicators);
    if (f.checked !== undefined) q = q.where("checked", "==", f.checked);
    if (f.refreshBefore) q = q.where("cacheExpiresAt", "<=", f.refreshBefore);
    if (f.gstr1Missing) q = f.gstr1Missing === "none" ? q.where("gstr1Missing", "==", 0) : q.where("gstr1Missing", ">", 0);
    if (f.gstr3bMissing) q = f.gstr3bMissing === "none" ? q.where("gstr3bMissing", "==", 0) : q.where("gstr3bMissing", ">", 0);
    if (f.gstr1Late) q = q.where("gstr1Late", ">", 0);
    if (f.gstr3bLate) q = q.where("gstr3bLate", ">", 0);
    if (f.assignedTo) q = q.where("assignedTo", "==", f.assignedTo);
    return q;
  }
  async countGstins(orgId: string, f: GstinFilter) { return (await this.gstinQuery(orgId, { ...f, search: undefined }).count().get()).data().count; }
  async listGstins(orgId: string, f: GstinFilter, o: { limit: number; cursor?: string; sort: GstinSort }): Promise<Page<GstinRecord>> {
    const term = f.search?.trim();
    if (term) { // prefix search: single page, other filters applied in memory over the (small) candidate set
      const base = this.col(orgId, "gstins");
      const up = term.toUpperCase(), lo = term.toLowerCase();
      const [a, b] = await Promise.all([
        base.orderBy(FieldPath.documentId()).startAt(up).endAt(up + "").limit(o.limit).get(),
        base.orderBy("clientNameLower").startAt(lo).endAt(lo + "").limit(o.limit).get(),
      ]);
      const seen = new Map<string, GstinRecord>();
      for (const d of [...a.docs, ...b.docs]) seen.set(d.id, strip<GstinRecord>(d.data())!);
      return { items: [...seen.values()].filter((r) => matchGstin(r, { ...f, search: undefined })).slice(0, o.limit) };
    }
    let q = this.gstinQuery(orgId, f);
    const dir = o.sort.dir;
    const cur = decodeCursor<{ v: string; id: string }>(o.cursor);
    if (o.sort.by === "gstin") {
      q = q.orderBy(FieldPath.documentId(), dir);
      if (cur) q = q.startAfter(cur.id);
    } else {
      q = q.orderBy("lastCheckedAt", dir).orderBy(FieldPath.documentId(), dir);
      if (cur) q = q.startAfter(cur.v, cur.id);
    }
    const snap = await q.limit(o.limit + 1).get();
    const docs = snap.docs.slice(0, o.limit);
    const items = docs.map((d) => strip<GstinRecord>(d.data())!);
    const last = items[items.length - 1];
    return { items, nextCursor: snap.docs.length > o.limit && last ? encodeCursor({ v: last.lastCheckedAt ?? "", id: last.gstin }) : undefined };
  }

  // ---- returns (flat collection, one doc per gstin/type/period) -------------------------------
  async putReturns(orgId: string, _gstin: string, records: NormalizedReturn[]) {
    void _gstin;
    for (const part of chunks(records, 400)) {
      const b = this.db.batch();
      for (const r of part) b.set(this.col(orgId, "returns").doc(r.id), r as unknown as DocumentData);
      await b.commit();
    }
  }
  async listReturns(orgId: string, gstin: string) {
    const snap = await this.col(orgId, "returns").where("gstin", "==", gstin).orderBy(FieldPath.documentId()).get();
    return snap.docs.map((d) => d.data() as NormalizedReturn);
  }
  async queryReturns(orgId: string, f: ReturnFilter, o: { limit: number; cursor?: string; dir: "asc" | "desc" }): Promise<Page<NormalizedReturn>> {
    let q: Query = this.col(orgId, "returns");
    if (f.gstin) q = q.where("gstin", "==", f.gstin);
    if (f.returnType) q = q.where("returnType", "==", f.returnType);
    if (f.financialYear) q = q.where("financialYear", "==", f.financialYear);
    if (f.period) q = q.where("period", "==", f.period);
    if (f.state) q = q.where("state", "==", f.state);
    if (f.status) q = q.where("status", "==", f.status);
    const field = f.dueFrom || f.dueTo ? "dueDate" : f.filedFrom || f.filedTo ? "filingDate" : null;
    const from = field === "dueDate" ? f.dueFrom : f.filedFrom, to = field === "dueDate" ? f.dueTo : f.filedTo;
    const cur = decodeCursor<{ v: string; id: string }>(o.cursor);
    if (field) { // requires a composite index per equality-filter set + this field (declared when indexes are generated)
      if (from) q = q.where(field, ">=", from);
      if (to) q = q.where(field, "<=", to);
      q = q.orderBy(field, o.dir).orderBy(FieldPath.documentId(), o.dir);
      if (cur) q = q.startAfter(cur.v, cur.id);
    } else {
      q = q.orderBy(FieldPath.documentId(), o.dir);
      if (cur) q = q.startAfter(cur.id);
    }
    const snap = await q.limit(o.limit + 1).get();
    const docs = snap.docs.slice(0, o.limit);
    const items = docs.map((d) => d.data() as NormalizedReturn);
    const last = items[items.length - 1];
    const v = last ? (field === "dueDate" ? last.dueDate : field === "filingDate" ? last.filingDate ?? "" : last.id) : "";
    return { items, nextCursor: snap.docs.length > o.limit && last ? encodeCursor({ v, id: last.id }) : undefined };
  }

  async listDueClients(beforeIso: string, limit: number) {
    // Collection-group query on `clients` (nextVerifyAt asc) — needs a collection-group index; UNVERIFIED (no emulator).
    const snap = await this.db.collectionGroup("clients").where("nextVerifyAt", "<=", beforeIso).orderBy("nextVerifyAt", "asc").limit(limit).get();
    return snap.docs.flatMap((d) => {
      const c = d.data() as Client; const orgId = d.ref.parent.parent?.id;
      return orgId && c.status === "active" && c.verifySchedule && c.nextVerifyAt ? [{ orgId, clientId: c.id, gstin: c.gstin, nextVerifyAt: c.nextVerifyAt }] : [];
    });
  }
  async getVerification(orgId: string, gstin: string) { const d = await this.col(orgId, "verifications").doc(gstin).get(); return d.exists ? (d.data() as VerificationRecord) : null; }
  async getVerifications(orgId: string, gstins: string[]) {
    const col = this.col(orgId, "verifications");
    const ids = [...new Set(gstins)];
    const out: VerificationRecord[] = [];
    for (let i = 0; i < ids.length; i += 300) {                       // Firestore getAll: one round trip for up to 300 documents
      const snaps = await this.db.getAll(...ids.slice(i, i + 300).map((g) => col.doc(g)));
      for (const d of snaps) if (d.exists) out.push(d.data() as VerificationRecord);
    }
    return out;
  }
  async putVerification(orgId: string, r: VerificationRecord) { await this.col(orgId, "verifications").doc(r.gstin).set(r as unknown as DocumentData); }
  async listVerifications(orgId: string, limit: number, o: { saved?: boolean; tag?: string } = {}) {
    // saved=true needs a composite index (saved ASC, verifiedAt DESC) — UNVERIFIED, see DATABASE_API.md.
    let q: Query = this.col(orgId, "verifications");
    if (o.saved) q = q.where("saved", "==", true);
    if (o.tag) q = q.where("tags", "array-contains", o.tag); // composite index (tags, verifiedAt desc) — UNVERIFIED
    return (await q.orderBy("verifiedAt", "desc").limit(limit).get()).docs.map((d) => d.data() as VerificationRecord);
  }
  async bumpCost(scope: string, period: string, d: Partial<CostCounters>) {
    const inc: DocumentData = {};
    for (const [k, v] of Object.entries(d)) if (v) inc[k] = FieldValue.increment(v);
    if (Object.keys(inc).length) await this.db.collection("costCounters").doc(`${scope.replaceAll("/", "_")}__${period}`).set(inc, { merge: true });
  }
  async getCost(scope: string, period: string) {
    const d = await this.db.collection("costCounters").doc(`${scope.replaceAll("/", "_")}__${period}`).get();
    return { ...ZERO_COST, ...((d.data() ?? {}) as Partial<CostCounters>) };
  }
  async getSharedResult(gstin: string) { const d = await this.db.collection("sharedResults").doc(gstin).get(); return d.exists ? (d.data() as SharedResult) : null; }
  async putSharedResult(r: SharedResult) { await this.db.collection("sharedResults").doc(r.gstin).set(r as unknown as DocumentData); }
  async deleteVerification(orgId: string, gstin: string) { await this.col(orgId, "verifications").doc(gstin).delete(); }
  async createConcern(orgId: string, c: Concern) { await this.col(orgId, "concerns").doc(c.id).set(JSON.parse(JSON.stringify(c)) as DocumentData); }
  async getConcern(orgId: string, id: string) { const d = await this.col(orgId, "concerns").doc(id).get(); return d.exists ? (d.data() as Concern) : null; }
  async listConcerns(orgId: string, o: { limit: number; status?: ConcernStatus; gstin?: string }) {
    // status/gstin + createdAt desc need composite indexes — UNVERIFIED (see DATABASE_API.md).
    let q: Query = this.col(orgId, "concerns");
    if (o.status) q = q.where("status", "==", o.status);
    if (o.gstin) q = q.where("gstin", "==", o.gstin);
    return (await q.orderBy("createdAt", "desc").limit(o.limit).get()).docs.map((d) => d.data() as Concern);
  }
  async updateConcern(orgId: string, id: string, patch: Partial<Pick<Concern, "status" | "resolution" | "reviewedBy" | "updatedAt">>) {
    const ref = this.col(orgId, "concerns").doc(id);
    const d = await ref.get(); if (!d.exists) return null;
    await ref.update(JSON.parse(JSON.stringify(patch)) as DocumentData);
    return (await ref.get()).data() as Concern;
  }
  async addCheck(orgId: string, c: CheckEntry) { await this.col(orgId, "checks").doc(c.id).set(c as unknown as DocumentData); }
  async listChecks(orgId: string, limit: number) { return (await this.col(orgId, "checks").orderBy("at", "desc").limit(limit).get()).docs.map((d) => d.data() as CheckEntry); }
  async addAudit(e: AuditEntry) { await this.col(e.organizationId, "auditLogs").doc(e.id).set(e as unknown as DocumentData); }
  async listAudit(orgId: string, limit: number) { return (await this.col(orgId, "auditLogs").orderBy("at", "desc").limit(limit).get()).docs.map((d) => d.data() as AuditEntry); }
  async addAlert(orgId: string, a: Alert) { await this.col(orgId, "alerts").doc(a.id).set(a as unknown as DocumentData); }
  async listAlerts(orgId: string, limit: number, o: { unread?: boolean } = {}) {
    // unread=true needs a composite index (read ASC, at DESC) — UNVERIFIED (no emulator).
    let q: Query = this.col(orgId, "alerts");
    if (o.unread) q = q.where("read", "==", false);
    return (await q.orderBy("at", "desc").limit(limit).get()).docs.map((d) => d.data() as Alert);
  }
  async markAlerts(orgId: string, o: { ids?: string[]; all?: boolean }, read: boolean) {
    const col = this.col(orgId, "alerts"); let n = 0;
    const apply = async (refs: FirebaseFirestore.DocumentReference[]) => {
      for (let i = 0; i < refs.length; i += 400) { const b = this.db.batch(); for (const r of refs.slice(i, i + 400)) b.update(r, { read }); await b.commit(); n += Math.min(400, refs.length - i); }
    };
    if (o.all) {
      for (;;) { // page through the opposite state until none is left (bounded: 20 × 400)
        const snap = await col.where("read", "==", !read).limit(400).get();
        if (snap.empty) break; await apply(snap.docs.map((d) => d.ref)); if (n >= 8000) break;
      }
    } else {
      const snaps = await Promise.all((o.ids ?? []).slice(0, 1000).map((id) => col.doc(id).get()));
      await apply(snaps.filter((s) => s.exists && (s.data() as Alert).read !== read).map((s) => s.ref));
    }
    return n;
  }
  async countUnreadAlerts(orgId: string) { return (await this.col(orgId, "alerts").where("read", "==", false).count().get()).data().count; }

  // ---- bulk jobs ------------------------------------------------------------------------------
  private jobUpdates(d: JobDeltas): DocumentData {
    const u: DocumentData = {};
    for (const k of COUNT_KEYS) if (d[k]) u[`counts.${k}`] = FieldValue.increment(d[k]!);
    if (d.consumed) u["quota.consumed"] = FieldValue.increment(d.consumed);
    if (d.released) u["quota.released"] = FieldValue.increment(d.released);
    if (d.reserved) u["quota.reserved"] = FieldValue.increment(d.reserved);
    if (d.skipped) u.skipped = FieldValue.increment(d.skipped);
    return u;
  }
  async createJob(orgId: string, job: BulkJob, items: BulkJobItem[]) {
    if (job.organizationId !== orgId) throw new Error("ORG_MISMATCH");
    for (const part of chunks(items, 400)) { // items first, job last: the job becomes visible only once complete
      const b = this.db.batch();
      for (const i of part) b.set(this.itemsCol(orgId, job.id).doc(i.id), i as unknown as DocumentData);
      await b.commit();
    }
    await this.jobRef(orgId, job.id).create(job as unknown as DocumentData);
  }
  async getJob(orgId: string, id: string) { return ((await this.jobRef(orgId, id).get()).data() as BulkJob | undefined) ?? null; }
  async listJobs(orgId: string, limit: number) { return (await this.col(orgId, "jobs").orderBy("createdAt", "desc").limit(limit).get()).docs.map((d) => d.data() as BulkJob); }
  async incrementJob(orgId: string, id: string, d: JobDeltas, patch: Partial<BulkJob> = {}) {
    const ref = this.jobRef(orgId, id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.update(ref, { ...this.jobUpdates(d), ...patch });
      return null;
    }).then(() => this.getJob(orgId, id));
  }
  async listJobItems(orgId: string, jobId: string, o: { status?: JobItemStatus; limit: number; cursor?: string }): Promise<Page<BulkJobItem>> {
    let q: Query = this.itemsCol(orgId, jobId);
    if (o.status) q = q.where("status", "==", o.status);
    q = q.orderBy(FieldPath.documentId());
    const cur = decodeCursor<{ id: string }>(o.cursor);
    if (cur) q = q.startAfter(cur.id);
    const snap = await q.limit(o.limit + 1).get();
    const docs = snap.docs.slice(0, o.limit);
    return { items: docs.map((d) => d.data() as BulkJobItem), nextCursor: snap.docs.length > o.limit ? encodeCursor({ id: docs[docs.length - 1].id }) : undefined };
  }
  async claimJobItems(orgId: string, jobId: string, n: number, nowIso: string) {
    const jref = this.jobRef(orgId, jobId);
    return this.db.runTransaction(async (tx) => {
      const [job, snap] = await Promise.all([tx.get(jref), tx.get(this.itemsCol(orgId, jobId).where("status", "==", "queued").limit(n))]);
      if (!job.exists || snap.empty) return [];
      const out: BulkJobItem[] = [];
      for (const d of snap.docs) {
        const it = d.data() as BulkJobItem;
        const next = { ...it, status: "processing" as const, attempts: it.attempts + 1, claimedAt: nowIso };
        tx.update(d.ref, { status: "processing", attempts: next.attempts, claimedAt: nowIso });
        out.push(next);
      }
      const j = job.data() as BulkJob;
      tx.update(jref, { "counts.queued": FieldValue.increment(-out.length), "counts.processing": FieldValue.increment(out.length),
        ...(j.status === "queued" || !j.startedAt ? { status: "running", startedAt: j.startedAt ?? nowIso } : {}) });
      return out;
    });
  }
  async finishJobItem(orgId: string, jobId: string, itemId: string, patch: Partial<BulkJobItem>) {
    const iref = this.itemsCol(orgId, jobId).doc(itemId), jref = this.jobRef(orgId, jobId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(iref);
      const it = snap.data() as BulkJobItem | undefined;
      if (!it || it.settled || it.status !== "processing") return false;
      const status = (patch.status ?? it.status) as "succeeded" | "cached" | "failed" | "cancelled";
      tx.update(iref, { ...patch, settled: true });
      tx.update(jref, { "counts.processing": FieldValue.increment(-1), [`counts.${status}`]: FieldValue.increment(1) });
      return true;
    });
  }
  async cancelQueuedItems(orgId: string, jobId: string) {
    const jref = this.jobRef(orgId, jobId);
    const all: BulkJobItem[] = [];
    for (;;) {
      const page = await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(this.itemsCol(orgId, jobId).where("status", "==", "queued").limit(200));
        for (const d of snap.docs) tx.update(d.ref, { status: "cancelled", settled: true });
        if (snap.size) tx.update(jref, { "counts.queued": FieldValue.increment(-snap.size), "counts.cancelled": FieldValue.increment(snap.size) });
        return snap.docs.map((d) => ({ ...(d.data() as BulkJobItem), status: "cancelled" as const }));
      });
      all.push(...page);
      if (page.length < 200) return all;
    }
  }
  async requeueStaleItems(orgId: string, jobId: string, olderThanIso: string, maxAttempts: number) {
    const jref = this.jobRef(orgId, jobId);
    return this.db.runTransaction(async (tx) => {
      // composite index (status, claimedAt) required
      const snap = await tx.get(this.itemsCol(orgId, jobId).where("status", "==", "processing").where("claimedAt", "<", olderThanIso).limit(400));
      let requeued = 0;
      const failed: BulkJobItem[] = [];
      for (const d of snap.docs) {
        const it = d.data() as BulkJobItem;
        if (it.attempts >= maxAttempts) {
          tx.update(d.ref, { status: "failed", settled: true, errorCode: "WORKER_TIMEOUT", retryable: true });
          failed.push({ ...it, status: "failed" });
        } else { tx.update(d.ref, { status: "queued" }); requeued++; }
      }
      if (snap.size) tx.update(jref, { "counts.processing": FieldValue.increment(-snap.size), "counts.queued": FieldValue.increment(requeued), "counts.failed": FieldValue.increment(failed.length) });
      return { requeued, failed };
    });
  }
  async requeueFailedItems(orgId: string, jobId: string) {
    const jref = this.jobRef(orgId, jobId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(this.itemsCol(orgId, jobId).where("status", "==", "failed").where("retryable", "==", true).limit(400));
      for (const d of snap.docs) tx.update(d.ref, { status: "queued", settled: false, held: false, errorCode: FieldValue.delete(), retryable: FieldValue.delete(), completedAt: FieldValue.delete() });
      if (snap.size) tx.update(jref, { "counts.failed": FieldValue.increment(-snap.size), "counts.queued": FieldValue.increment(snap.size), status: "queued", completedAt: FieldValue.delete() });
      return snap.docs.map((d) => ({ ...(d.data() as BulkJobItem), status: "queued" as const, held: false, settled: false }));
    });
  }
  // ---- imports (chunks in a subcollection; the record becomes visible only after its chunks are written)
  private importRef = (orgId: string, id: string) => this.col(orgId, "imports").doc(id);
  async putImport(orgId: string, rec: ImportRecord, chunks?: ImportRowData[][]) {
    if (rec.organizationId !== orgId) throw new Error("ORG_MISMATCH");
    if (chunks) {
      for (let i = 0; i < chunks.length; i += 100) { // each chunk doc holds ~500 rows (≈100 KB, far below the 1 MB limit)
        const b = this.db.batch();
        chunks.slice(i, i + 100).forEach((rows, j) => b.set(this.importRef(orgId, rec.id).collection("chunks").doc(String(i + j)), { rows }));
        await b.commit();
      }
    }
    await this.importRef(orgId, rec.id).set(rec as unknown as DocumentData);
  }
  async getImport(orgId: string, id: string) { return ((await this.importRef(orgId, id).get()).data() as ImportRecord | undefined) ?? null; }
  async listImports(orgId: string, limit: number) { return (await this.col(orgId, "imports").orderBy("createdAt", "desc").limit(limit).get()).docs.map((d) => d.data() as ImportRecord); }
  async incrementImport(orgId: string, id: string, d: ImportDeltas, patch: Partial<ImportRecord> = {}, addFailed: ImportFailedRow[] = []) {
    const ref = this.importRef(orgId, id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const r = snap.data() as ImportRecord;
      const failedRows = [...r.failedRows];
      let truncated = r.failedRowsTruncated;
      for (const f of addFailed) { if (failedRows.length < 1000) failedRows.push(f); else truncated = true; }
      tx.update(ref, {
        "counts.imported": FieldValue.increment(d.imported ?? 0), "counts.failedToCreate": FieldValue.increment(d.failedToCreate ?? 0),
        "counts.skippedPlanLimit": FieldValue.increment(d.skippedPlanLimit ?? 0), processed: FieldValue.increment(d.processed ?? 0),
        failedRows, failedRowsTruncated: truncated, ...patch,
      });
    });
    return this.getImport(orgId, id);
  }
  async getImportChunk(orgId: string, id: string, index: number) {
    const d = (await this.importRef(orgId, id).collection("chunks").doc(String(index)).get()).data() as { rows: ImportRowData[] } | undefined;
    return d?.rows ?? null;
  }
  async claimIdempotency(orgId: string, key: string, jobId: string, fingerprint: string, nowIso: string) {
    const ref = this.col(orgId, "idempotency").doc(key);
    try {
      await ref.create({ jobId, fingerprint, createdAt: nowIso });
      return null;
    } catch (e) {
      if ((e as { code?: number }).code !== 6) throw e; // 6 = ALREADY_EXISTS
      const d = (await ref.get()).data() as { jobId: string; fingerprint: string; createdAt: string } | undefined;
      return d ? { jobId: d.jobId, fingerprint: d.fingerprint, createdAt: d.createdAt } : null;
    }
  }
  async releaseIdempotency(orgId: string, key: string, ifJobId: string) {
    const ref = this.col(orgId, "idempotency").doc(key);
    await this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists && (s.data() as { jobId: string }).jobId === ifJobId) tx.delete(ref);
    });
  }
}
