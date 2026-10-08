/** Liveness: the process is up and serving. Public, no dependencies, no data. Use /api/ready to check that it can actually do work. */
export const GET = async (): Promise<Response> =>
  new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
