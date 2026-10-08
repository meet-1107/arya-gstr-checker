import { isOutcome } from "@/lib/verification";
import { query, tenant } from "@/server/api";
import { container } from "@/server/container";
import type { PortfolioFreshness } from "@/lib/portfolio";

const FRESH: PortfolioFreshness[] = ["fresh", "stale", "expired", "never"];
const flag = (v?: string) => (v === "1" ? true : v === "0" ? false : undefined);

/** The client portfolio: one row per client with its latest known GST answer + freshness + recent change, and a summary of the whole portfolio. */
export const GET = tenant(async ({ req, ctx }) => {
  const q = query(req);
  return container().portfolio.list(ctx, {
    q: q.q, status: q.status === "never" ? "never" : q.status && isOutcome(q.status) ? q.status : undefined,
    freshness: FRESH.includes(q.freshness as PortfolioFreshness) ? (q.freshness as PortfolioFreshness) : undefined,
    changed: q.changed === "1" || undefined, tag: q.tag || undefined, assignedTo: q.assignedTo || undefined, scheduled: flag(q.scheduled),
    needsRefresh: q.needsRefresh === "1" || undefined, attention: q.attention === "1" || undefined,
    sort: q.sort, limit: Number(q.limit ?? 25), cursor: q.cursor,
  });
});
