import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlan } from "@/config/plans";
import { isWritable } from "@/lib/subscription";
import { AppError, type Ctx } from "@/lib/errors";
import { validateGstin } from "@/lib/gstin";
import { clientGstins, panOf, stateNameOf } from "@/lib/client-gstins";
import { assertCan } from "@/lib/permissions";
import type { Client, Store } from "@/lib/store/types";

const optStr = z.string().trim().max(200).optional().transform((v) => v || undefined);

export const clientInput = z.object({
  name: z.string().trim().min(1).max(200),
  gstin: z.string(),
  legalName: optStr, tradeName: optStr, contactPerson: optStr,
  email: z.string().trim().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().max(20).optional().transform((v) => v || undefined),
  assignedTo: optStr,
  filingFrequency: z.enum(["MONTHLY", "QUARTERLY"]).default("MONTHLY"),
  notes: z.string().trim().max(2000).optional().transform((v) => v || undefined),
});
export type ClientInput = z.input<typeof clientInput>;

export class ClientService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  private async assertWritable(ctx: Ctx) {
    assertCan(ctx.role, "clients:write");
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    if (!isWritable(org, this.now())) {
      throw new AppError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.", 403);
    }
    return org;
  }

  async create(ctx: Ctx, raw: ClientInput): Promise<Client> {
    const org = await this.assertWritable(ctx);
    const parsed = clientInput.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    const v = validateGstin(parsed.data.gstin);
    if (!v.valid) throw new AppError("INVALID_GSTIN", `Invalid GSTIN (${v.reason}).`);
    if (parsed.data.assignedTo && !(await this.store.getMember(ctx.orgId, parsed.data.assignedTo))) {
      throw new AppError("INVALID_ASSIGNEE", "Assignee is not a member of this organization.");
    }
    const limit = getPlan(org.plan).clientLimit;
    if (limit !== null && (await this.store.countClients(ctx.orgId)) >= limit) {
      throw new AppError("CLIENT_LIMIT_REACHED", `Your ${getPlan(org.plan).name} plan allows ${limit} active clients. Archive a client or upgrade to add more.`, 402);
    }
    if (await this.store.findClientByGstin(ctx.orgId, v.gstin)) {
      throw new AppError("DUPLICATE_GSTIN", "A client with this GSTIN already exists.", 409);
    }
    const ts = this.now().toISOString();
    const client: Client = { ...parsed.data, gstin: v.gstin, id: randomUUID(), status: "active", createdAt: ts, updatedAt: ts };
    await this.store.createClient(ctx.orgId, client);
    await this.store.putGstinRecord(ctx.orgId, { gstin: v.gstin, clientId: client.id, status: "Unknown", checked: false, clientName: client.name, assignedTo: client.assignedTo });
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "CLIENT_CREATED", target: client.id, at: ts });
    return client;
  }

  async get(ctx: Ctx, id: string): Promise<Client> {
    assertCan(ctx.role, "clients:read");
    const c = await this.store.getClient(ctx.orgId, id);
    if (!c) throw new AppError("CLIENT_NOT_FOUND", "Client not found.", 404);
    return c;
  }

  /** `status` defaults to active; archived clients are listed only when asked for (they are not billed, checked or counted). */
  async list(ctx: Ctx, o: { limit?: number; cursor?: string; search?: string; status?: string } = {}) {
    assertCan(ctx.role, "clients:read");
    const status = o.status === "archived" || o.status === "all" ? o.status : "active";
    return this.store.listClients(ctx.orgId, { ...o, status, limit: Math.min(Math.max(o.limit ?? 25, 1), 100) });
  }

  /**
   * Archive = stop billing, checking and counting this client without deleting anything (history is kept). Reversible.
   * Only active clients are billable, so archiving is how a CA stops paying for a client they no longer manage.
   */
  async archive(ctx: Ctx, id: string): Promise<Client> { return this.setArchived(ctx, id, true); }

  /** Restore an archived client. Subject to the same plan cap as adding a new client. */
  async restore(ctx: Ctx, id: string): Promise<Client> { return this.setArchived(ctx, id, false); }

  private async setArchived(ctx: Ctx, id: string, archived: boolean): Promise<Client> {
    const org = await this.assertWritable(ctx);
    const c = await this.get(ctx, id);
    if ((c.status === "archived") === archived) return c; // idempotent
    if (!archived) {
      const limit = getPlan(org.plan).clientLimit;
      if (limit !== null && (await this.store.countClients(ctx.orgId)) >= limit) {
        throw new AppError("CLIENT_LIMIT_REACHED", `Your ${getPlan(org.plan).name} plan allows ${limit} active clients. Archive another client or upgrade first.`, 402);
      }
    }
    const ts = this.now().toISOString();
    await this.store.updateClient(ctx.orgId, id, { status: archived ? "archived" : "active", updatedAt: ts });
    for (const g of clientGstins(c)) { // keep the denormalized flag in sync on EVERY GSTIN of the firm: lists, counts and bulk selection read it
      const rec = await this.store.getGstinRecord(ctx.orgId, g);
      if (rec) await this.store.putGstinRecord(ctx.orgId, { ...rec, archived: archived ? true : undefined });
    }
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: archived ? "CLIENT_ARCHIVED" : "CLIENT_RESTORED", target: id, at: ts });
    return { ...c, status: archived ? "archived" : "active", updatedAt: ts };
  }

  /**
   * Add another GSTIN (another state registration) to a client firm. The firm stays ONE billing unit.
   * Rules: within the plan's GSTINs-per-client limit; same PAN as the firm (otherwise it is a different business and should be its own client —
   * this is also what stops unrelated businesses being bundled into one billed client); not already used anywhere in this organization.
   */
  async addGstin(ctx: Ctx, clientId: string, input: unknown): Promise<Client> {
    const org = await this.assertWritable(ctx);
    if (typeof input !== "string") throw new AppError("VALIDATION_ERROR", "gstin must be a string.");
    const c = await this.get(ctx, clientId);
    if (c.status === "archived") throw new AppError("CLIENT_ARCHIVED", "This client is archived. Restore it before adding GSTINs.", 409);
    const v = validateGstin(input);
    if (!v.valid) throw new AppError("INVALID_GSTIN", `Invalid GSTIN (${v.reason}).`);
    const have = clientGstins(c);
    const plan = getPlan(org.plan);
    if (plan.gstinsPerClient !== null && have.length >= plan.gstinsPerClient) {
      throw new AppError("CLIENT_GSTIN_LIMIT_REACHED", `Your ${plan.name} plan allows ${plan.gstinsPerClient} GSTIN${plan.gstinsPerClient === 1 ? "" : "s"} per client firm.${plan.id === "free" ? " Upgrade to add more." : ""}`, 402);
    }
    if (panOf(v.gstin) !== panOf(c.gstin)) {
      throw new AppError("GSTIN_PAN_MISMATCH", "GSTINs of one client firm must share the same PAN. A different PAN is a different business: add it as its own client.", 422);
    }
    const owner = await this.store.findClientByGstin(ctx.orgId, v.gstin);
    if (owner) throw new AppError("DUPLICATE_GSTIN", owner.id === c.id ? "This GSTIN is already on this client." : `This GSTIN already belongs to the client "${owner.name}".`, 409);
    const ts = this.now().toISOString();
    const gstins = [...have, v.gstin];
    await this.store.updateClient(ctx.orgId, c.id, { gstins, updatedAt: ts });
    await this.store.putGstinRecord(ctx.orgId, { gstin: v.gstin, clientId: c.id, status: "Unknown", checked: false, clientName: c.name, assignedTo: c.assignedTo });
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "CLIENT_UPDATED", target: c.id, at: ts, metadata: { addedGstin: v.gstin } });
    return { ...c, gstins, updatedAt: ts };
  }

  /** Every GSTIN of a client firm with its latest stored status (reads stored data only; no provider calls). */
  async listGstins(ctx: Ctx, clientId: string) {
    const c = await this.get(ctx, clientId);
    const all = clientGstins(c);
    const recs = new Map((await this.store.getGstinRecords(ctx.orgId, all)).map((r) => [r.gstin, r]));
    return all.map((g) => {
      const r = recs.get(g);
      return { gstin: g, primary: g === c.gstin, state: stateNameOf(g), status: r?.status ?? "Unknown", checked: r?.checked === true, lastCheckedAt: r?.lastCheckedAt, indicator: r?.indicator };
    });
  }

  /** Remove an additional GSTIN (its stored data goes with it). The primary GSTIN cannot be removed: delete the client instead. */
  async removeGstin(ctx: Ctx, clientId: string, input: unknown): Promise<Client> {
    await this.assertWritable(ctx);
    if (typeof input !== "string") throw new AppError("VALIDATION_ERROR", "gstin must be a string.");
    const c = await this.get(ctx, clientId);
    const g = input.trim().toUpperCase();
    if (g === c.gstin) throw new AppError("CANNOT_REMOVE_PRIMARY_GSTIN", "The primary GSTIN cannot be removed. Delete the client instead.", 409);
    const have = clientGstins(c);
    if (!have.includes(g)) throw new AppError("GSTIN_NOT_ON_CLIENT", "This GSTIN is not on this client.", 404);
    const ts = this.now().toISOString();
    const gstins = have.filter((x) => x !== g);
    await this.store.updateClient(ctx.orgId, c.id, { gstins, updatedAt: ts });
    await this.store.deleteGstinData(ctx.orgId, g);
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "CLIENT_UPDATED", target: c.id, at: ts, metadata: { removedGstin: g } });
    return { ...c, gstins, updatedAt: ts };
  }

  async update(ctx: Ctx, id: string, patch: Partial<ClientInput>): Promise<void> {
    await this.assertWritable(ctx);
    const existing = await this.get(ctx, id);
    // GSTIN is immutable: changing it would orphan cached verification data.
    const parsed = clientInput.partial().omit({ gstin: true }).safeParse(patch);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    const ts = this.now().toISOString();
    if (parsed.data.assignedTo && !(await this.store.getMember(ctx.orgId, parsed.data.assignedTo))) {
      throw new AppError("INVALID_ASSIGNEE", "Assignee is not a member of this organization.");
    }
    await this.store.updateClient(ctx.orgId, id, { ...parsed.data, updatedAt: ts });
    if ("name" in parsed.data || "assignedTo" in parsed.data) {
      for (const g of clientGstins(existing)) { // keep denormalized list/search fields in sync on every GSTIN of the firm
        const rec = await this.store.getGstinRecord(ctx.orgId, g);
        if (rec) await this.store.putGstinRecord(ctx.orgId, { ...rec, clientName: parsed.data.name ?? rec.clientName, assignedTo: "assignedTo" in parsed.data ? parsed.data.assignedTo : rec.assignedTo });
      }
    }
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "CLIENT_UPDATED", target: id, at: ts });
  }

  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.assertWritable(ctx);
    const existing = await this.get(ctx, id);
    await this.store.deleteClient(ctx.orgId, id);
    for (const g of clientGstins(existing)) await this.store.deleteGstinData(ctx.orgId, g); // no orphaned GSTIN rows, counts or returns
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "CLIENT_DELETED", target: id, at: this.now().toISOString() });
  }
}
