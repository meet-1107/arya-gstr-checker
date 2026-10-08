// Client JS per route from a production build (`npm run build` first).
//   node scripts/bundle-report.mjs            → table of routes (gzip KB of every client chunk the route needs)
//   node scripts/bundle-report.mjs --json     → machine-readable
//   node scripts/bundle-report.mjs --budget   → exit 1 if a route exceeds its budget in config/performance.json
// "Route JS" = union of chunks referenced by the route's client-reference manifest (shared framework + layouts + page). It is an
// approximation of First Load JS (Turbopack does not print one), good for before/after comparisons, not an absolute number.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const dist = process.env.NEXT_DIST_DIR || ".next";
const appDir = path.join(root, dist, "server/app");
if (!fs.existsSync(appDir)) { console.error("No production build found. Run `npm run build` first."); process.exit(2); }

const gz = new Map();
const gzipKb = (rel) => {
  if (gz.has(rel)) return gz.get(rel);
  const f = path.join(root, dist, rel.replace(/^\/_next\//, ""));
  const kb = fs.existsSync(f) ? zlib.gzipSync(fs.readFileSync(f)).length / 1024 : 0;
  gz.set(rel, kb); return kb;
};

function* manifests(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* manifests(p);
    else if (e.name === "page_client-reference-manifest.js") yield p;
  }
}

const rows = [];
for (const file of manifests(appDir)) {
  const ctx = { globalThis: { __RSC_MANIFEST: {} } }; ctx.globalThis.__RSC_MANIFEST = {};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), ctx);
  const [[route, m]] = Object.entries(ctx.globalThis.__RSC_MANIFEST);
  const chunks = new Set();
  for (const c of Object.values(m.clientModules ?? {})) for (const ch of c.chunks ?? []) if (ch.endsWith(".js")) chunks.add(ch);
  for (const f of Object.values(m.entryJSFiles ?? {}).flat()) if (f.endsWith(".js")) chunks.add(f.startsWith("/") ? f : `/_next/${f}`);
  let kb = 0; for (const c of chunks) kb += gzipKb(c);
  rows.push({ route: route.replace(/\/page$/, "").replace(/\/\([^)]*\)/g, "") || "/", chunks: chunks.size, gzipKb: Math.round(kb * 10) / 10 });
}
rows.sort((a, b) => b.gzipKb - a.gzipKb);

if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else { console.log("route".padEnd(34), "chunks", "gzip KB"); for (const r of rows) console.log(r.route.padEnd(34), String(r.chunks).padStart(6), r.gzipKb.toFixed(1).padStart(8)); }

if (process.argv.includes("--budget")) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "config/performance.json"), "utf8"));
  const over = rows.filter((r) => cfg.routeGzipKb[r.route] !== undefined && r.gzipKb > cfg.routeGzipKb[r.route]);
  for (const r of over) console.error(`OVER BUDGET ${r.route}: ${r.gzipKb} KB > ${cfg.routeGzipKb[r.route]} KB`);
  if (over.length) process.exit(1);
}
