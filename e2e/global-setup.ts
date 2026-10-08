/**
 * Warm-up. `next dev` compiles each route on its first request, which can take many seconds and made the first test to touch a route time out.
 * Visiting every page and API route once before the tests start moves that cost out of the tests. (Unauthenticated API calls answer 401 but still compile the route.)
 */
const PAGES = ["/", "/pricing", "/login", "/register", "/forgot-password", "/reset-password", "/verify-email", "/onboarding", "/invite", "/dashboard", "/verify", "/verify/bulk", "/portfolio",
  "/clients", "/clients/import", "/gstins", "/gstr-1", "/gstr-3b", "/bulk-checks", "/alerts", "/reports", "/reports/summary", "/team", "/billing", "/settings", "/audit-logs", "/concerns",
  // dynamic routes (a placeholder id is enough to compile them)
  "/bulk-checks/warmup", "/clients/warmup", "/clients/import/warmup", "/gstins/warmup"];
const API_GET = ["/api/health", "/api/me", "/api/dashboard", "/api/subscription", "/api/clients", "/api/gstins", "/api/portfolio", "/api/alerts", "/api/alerts?unread=1&limit=3", "/api/verify/recent",
  "/api/verify/costs", "/api/reports/clients", "/api/reports/summary", "/api/bulk-checks", "/api/members", "/api/imports", "/api/audit-logs", "/api/concerns", "/api/usage", "/api/returns/gstr1", "/api/bulk-checks/warmup", "/api/bulk-checks/warmup/items", "/api/bulk-checks/warmup/export", "/api/imports/warmup", "/api/imports/warmup/failed-rows", "/api/clients/warmup", "/api/gstins/warmup"];
const API_POST = ["/api/organizations", "/api/clients", "/api/verify", "/api/verify/save", "/api/verify/annotate", "/api/bulk-verify", "/api/bulk-verify/preview", "/api/portfolio/gstins", "/api/portfolio/schedule",
  "/api/portfolio/run-due", "/api/alerts/read", "/api/imports", "/api/imports/preview", "/api/members", "/api/invitations/accept", "/api/internal/portfolio-due"];

export default async function globalSetup(config: import("@playwright/test").FullConfig) {
  const base = config.projects[0].use.baseURL ?? "http://localhost:3170";
  const hit = async (path: string, method: "GET" | "POST") => {
    try { await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(120_000) }); } catch { /* a failed warm-up only means the test pays the compile cost */ }
  };
  const jobs = [...PAGES.map((p) => () => hit(p, "GET")), ...API_GET.map((p) => () => hit(p, "GET")), ...API_POST.map((p) => () => hit(p, "POST"))];
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 4 }, async () => { for (let j = queue.shift(); j; j = queue.shift()) await j(); }));
}
