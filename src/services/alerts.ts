import { AppError, type Ctx } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { ALERT_GROUPS, isAlertGroup } from "@/lib/alerts";
import type { Alert, Store } from "@/lib/store/types";

const MAX_LIST = 200, GROUP_SCAN = 500;

/**
 * Alerts are produced where the events happen (checks, verification change detection, bulk runs, imports, quota). This service only reads them
 * and manages their read state. "Read" is organization-wide (one shared inbox for the firm), not per user.
 */
export class AlertService {
  constructor(private store: Store) {}

  async list(ctx: Ctx, o: { unread?: boolean; group?: unknown; limit?: number } = {}): Promise<{ items: Alert[]; unreadCount: number; hasMore: boolean }> {
    assertCan(ctx.role, "dashboard:read");
    if (o.group !== undefined && !isAlertGroup(o.group)) throw new AppError("VALIDATION_ERROR", "Unknown alert group.", 400);
    const limit = Math.min(Math.max(Math.floor(o.limit ?? 30) || 30, 1), MAX_LIST);
    const types = o.group ? new Set<string>(ALERT_GROUPS[o.group as keyof typeof ALERT_GROUPS].types) : null;
    // A type group is filtered after reading (alerts are few and capped); an unfiltered list reads exactly limit+1.
    const raw = await this.store.listAlerts(ctx.orgId, types ? GROUP_SCAN : limit + 1, { unread: o.unread });
    const filtered = types ? raw.filter((a) => types.has(a.type)) : raw;
    return { items: filtered.slice(0, limit), unreadCount: await this.store.countUnreadAlerts(ctx.orgId), hasMore: filtered.length > limit };
  }

  async unreadCount(ctx: Ctx): Promise<number> {
    assertCan(ctx.role, "dashboard:read");
    return this.store.countUnreadAlerts(ctx.orgId);
  }

  /** `{ids}` or `{all:true}`; `read` defaults to true (pass false to mark unread). Viewers can read alerts but not change the shared inbox. */
  async markRead(ctx: Ctx, raw: { ids?: unknown; all?: unknown; read?: unknown }): Promise<{ changed: number; unreadCount: number }> {
    assertCan(ctx.role, "checks:run");
    const read = raw.read === undefined ? true : raw.read;
    if (typeof read !== "boolean") throw new AppError("VALIDATION_ERROR", "read must be true or false.", 400);
    let o: { ids?: string[]; all?: boolean };
    if (raw.all === true) o = { all: true };
    else if (Array.isArray(raw.ids) && raw.ids.length > 0 && raw.ids.length <= 1000 && raw.ids.every((x) => typeof x === "string")) o = { ids: raw.ids as string[] };
    else throw new AppError("VALIDATION_ERROR", "Provide ids (1–1000) or all: true.", 400);
    const changed = await this.store.markAlerts(ctx.orgId, o, read);
    return { changed, unreadCount: await this.store.countUnreadAlerts(ctx.orgId) };
  }
}
