// Usage:  node --env-file=.env.production scripts/preflight.mjs        (or set the variables in the shell / CI)
// Exits 1 if the configuration would make a production deployment unsafe or non-functional. Never contacts any service.
import path from "node:path";
import { pathToFileURL } from "node:url";

const { checkProductionEnv } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../src/config/preflight.ts")).href);
const r = checkProductionEnv(process.env);
for (const e of r.errors) console.error(`  ✗ ${e}`);
for (const w of r.warnings) console.warn(`  ! ${w}`);
console.log(r.ok ? `\nPreflight: OK (${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}).` : `\nPreflight: FAILED (${r.errors.length} error${r.errors.length === 1 ? "" : "s"}).`);
process.exit(r.ok ? 0 : 1);
