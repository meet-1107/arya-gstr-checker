// Pre-deployment configuration check. Pure and dependency-free (it is run by scripts/preflight.mjs before a deploy, and by tests).
// It reports what would make a PRODUCTION deployment unsafe or non-functional. It does not prove the environment works: it never contacts
// Firebase, the GST provider or anything else, and it cannot know whether a secret is correct — only that it is present and plausible.
export interface PreflightResult { ok: boolean; errors: string[]; warnings: string[] }

const has = (v: string | undefined) => !!v && v.trim() !== "";
const num = (v: string | undefined) => (has(v) ? Number(v) : undefined);

export function checkProductionEnv(env: Record<string, string | undefined>): PreflightResult {
  const errors: string[] = [], warnings: string[] = [];
  const err = (m: string) => errors.push(m), warn = (m: string) => warnings.push(m);

  // Data and identity must be the real ones.
  if ((env.STORE ?? "firestore") !== "firestore") err(`STORE=${env.STORE}: production requires STORE=firestore (the memory store loses everything on restart).`);
  if (!has(env.STORE)) warn("STORE is not set; production defaults to firestore.");
  if ((env.AUTH_MODE ?? "firebase") !== "firebase") err(`AUTH_MODE=${env.AUTH_MODE}: production requires AUTH_MODE=firebase (dev sign-in accepts forged tokens).`);
  if (env.NEXT_PUBLIC_AUTH_MODE === "dev") err("NEXT_PUBLIC_AUTH_MODE=dev would ship the dev sign-in screen to users.");

  // Firebase (browser + admin).
  for (const k of ["NEXT_PUBLIC_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_PROJECT_ID"]) if (!has(env[k])) err(`${k} is required (sign-in cannot work without it). NEXT_PUBLIC_* values are baked in at BUILD time.`);
  if (!has(env.FIREBASE_PROJECT_ID)) err("FIREBASE_PROJECT_ID is required for the server.");
  const email = has(env.FIREBASE_CLIENT_EMAIL), key = has(env.FIREBASE_PRIVATE_KEY);
  if (email !== key) err("FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set together (or both left empty to use Application Default Credentials).");
  if (!email && !key) warn("No service-account key set: the server will use Application Default Credentials (correct on Cloud Run with the right service account; otherwise Firestore calls fail).");
  if (key && !/BEGIN [A-Z ]*PRIVATE KEY/.test(env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"))) err("FIREBASE_PRIVATE_KEY does not look like a PEM private key (check the \\n escaping).");
  if (has(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) && has(env.FIREBASE_PROJECT_ID) && env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== env.FIREBASE_PROJECT_ID) err("NEXT_PUBLIC_FIREBASE_PROJECT_ID and FIREBASE_PROJECT_ID differ: the browser and the server would talk to different projects.");

  // GST provider.
  const provider = (env.GST_PROVIDER ?? "mock").toLowerCase();
  if (provider === "mock") {
    if (env.ALLOW_MOCK_IN_PRODUCTION === "true-for-staging-only") warn("GST_PROVIDER=mock is allowed by ALLOW_MOCK_IN_PRODUCTION: every verification result is FAKE. Staging only.");
    else err("GST_PROVIDER=mock: production refuses the mock provider (it returns fabricated registry answers).");
  } else if (provider === "gstinapi" || provider === "whitebooks") {
    err(`GST_PROVIDER=${provider}: no verified adapter exists yet, so every lookup would fail closed with GST_PROVIDER_NOT_CONFIGURED.`);
  } else err(`GST_PROVIDER=${provider} is not a known provider.`);
  warn("GST provider limits (rate, timeout, credit price) are UNVERIFIED defaults until a real provider contract is confirmed.");

  // Scenario-injection and dev switches must not be present.
  for (const k of ["MOCK_NOT_FOUND", "MOCK_TIMEOUT", "MOCK_DELAY_MS"]) if (has(env[k])) err(`${k} is a development scenario switch and must not be set in production.`);

  // Numeric knobs.
  for (const k of ["GST_RATE_LIMIT_PER_MIN", "GST_MAX_CONCURRENT", "GST_TIMEOUT_MS", "GST_RETRIES", "GST_BACKOFF_BASE_MS", "GST_BACKOFF_MAX_MS", "GST_BREAKER_THRESHOLD", "GST_BREAKER_COOLDOWN_MS", "BULK_CONCURRENCY"]) {
    const n = num(env[k]);
    if (has(env[k]) && !(Number.isFinite(n) && n! > 0)) err(`${k}=${env[k]} is not a positive number.`);
  }
  const timeout = num(env.GST_TIMEOUT_MS), conc = num(env.GST_MAX_CONCURRENT), bulk = num(env.BULK_CONCURRENCY);
  if (timeout !== undefined && timeout > 20_000) warn(`GST_TIMEOUT_MS=${timeout} exceeds the 20 s server deadline for a verification; the deadline wins.`);
  if (conc !== undefined && bulk !== undefined && bulk > conc) warn("BULK_CONCURRENCY is higher than GST_MAX_CONCURRENT; extra workers will just queue.");

  // Scheduler.
  if (!has(env.CRON_SECRET)) warn("CRON_SECRET is not set: the scheduled-verification endpoint is disabled (404).");
  else if (env.CRON_SECRET!.length < 24) err("CRON_SECRET is shorter than 24 characters.");

  // Single-instance behaviour that a multi-instance deployment would silently weaken.
  warn("The job queue, in-flight de-duplication and per-minute rate window are in-process: run ONE instance (or accept weaker guarantees) until a durable queue is added (ISSUE-006).");

  return { ok: errors.length === 0, errors, warnings };
}
