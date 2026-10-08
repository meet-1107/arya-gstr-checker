import { container } from "@/server/container";

const headers = { "content-type": "application/json", "cache-control": "no-store" };
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * Readiness: can this instance do real work? Builds the container (a misconfiguration throws here) and does one cheap read from the store.
 * Public, and deliberately says only WHICH check failed ("config" | "store"), never why: no error text, no config values, no data.
 * 200 {status:"ready"} or 503 {status:"unavailable", failing:[...]}. Intended for a load balancer / uptime monitor.
 */
export const GET = async (): Promise<Response> => {
  const failing: string[] = [];
  try {
    const c = container();
    try { await withTimeout(c.store.listMemberships("__readiness__"), 3000); } catch { failing.push("store"); }
  } catch { failing.push("config"); }
  return failing.length
    ? new Response(JSON.stringify({ status: "unavailable", failing }), { status: 503, headers })
    : new Response(JSON.stringify({ status: "ready" }), { status: 200, headers });
};
