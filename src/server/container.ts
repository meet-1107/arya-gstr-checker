// SERVER ONLY. Composition root: picks the store/auth/provider implementations from the environment.
import { FirebaseAuthVerifier, DevAuthVerifier, type AuthVerifier } from "@/lib/auth";
import { providerLimits, type ProviderLimits } from "@/config/provider";
import { MemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { createProvider } from "@/providers";
import { ResilientProvider } from "@/providers/gate";
import type { GstProvider } from "@/providers/types";
import { BulkService, InProcessQueue } from "@/services/bulk";
import { ImportService } from "@/services/imports";
import { AuditService, ConcernService, VerificationPrivacyService } from "@/services/trust";
import { CheckService } from "@/services/checks";
import { DashboardService } from "@/services/dashboard";
import { GstinQueryService, ReturnsQueryService } from "@/services/queries";
import { ClientService } from "@/services/clients";
import { OrganizationService } from "@/services/organizations";
import { SubscriptionService } from "@/services/subscription";
import { TeamService } from "@/services/team";
import { VerificationService } from "@/services/verification";
import { PortfolioService } from "@/services/portfolio";
import { AlertService } from "@/services/alerts";
import { ReportService } from "@/services/reports";
import { CostGuard } from "@/services/cost-guard";
import { costPolicy, type CostPolicy } from "@/config/cost-policy";
import { VerificationMetrics } from "@/lib/metrics";
import { ProviderHealth } from "@/lib/provider-health";
import { verificationPolicy } from "@/config/verification-policy";

export interface Container {
  store: Store; auth: AuthVerifier; provider: GstProvider;
  orgs: OrganizationService; team: TeamService; subs: SubscriptionService; clients: ClientService; checks: CheckService;
  gstins: GstinQueryService; returns: ReturnsQueryService; dashboard: DashboardService; bulk: BulkService; imports: ImportService;
  concerns: ConcernService; audit: AuditService; privacy: VerificationPrivacyService;
  verification: VerificationService; verificationMetrics: VerificationMetrics; costPolicy: CostPolicy; portfolio: PortfolioService; alerts: AlertService; reports: ReportService;
  queue: InProcessQueue; gate: ResilientProvider; limits: ProviderLimits;
}

export function buildContainer(env: Record<string, string | undefined> = process.env): Container {
  const prod = env.NODE_ENV === "production";
  const storeKind = env.STORE ?? (prod ? "firestore" : "memory");
  if (prod && storeKind !== "firestore") throw new Error("Production requires STORE=firestore.");

  let store: Store;
  if (storeKind === "firestore") {
    // Lazy require keeps firebase-admin out of memory/test runs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { adminFirestore } = require("@/lib/firebase/admin") as typeof import("@/lib/firebase/admin");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FirestoreStore } = require("@/lib/store/firestore") as typeof import("@/lib/store/firestore");
    store = new FirestoreStore(adminFirestore());
  } else store = new MemoryStore();

  let auth: AuthVerifier;
  if ((env.AUTH_MODE ?? "firebase") === "dev") auth = new DevAuthVerifier(env); // throws in production
  else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { adminAuth } = require("@/lib/firebase/admin") as typeof import("@/lib/firebase/admin");
    auth = new FirebaseAuthVerifier(() => adminAuth());
  }

  // ALL provider throughput control (concurrency, req/min, timeout, retry, breaker) lives in the gate. Limits are UNVERIFIED.
  const limits = providerLimits(env);
  const provider = createProvider(env);
  const gate = new ResilientProvider(provider, limits);
  const checks = new CheckService(store, gate);
  const verificationMetrics = new VerificationMetrics();
  // Freshness / provider-health policy is configuration (UNVERIFIED against any real provider's terms). Health also treats an open breaker as "down".
  const policy = verificationPolicy(env);
  const providerHealth = new ProviderHealth(policy, Date.now, () => gate.stats().breaker === "open");
  // Paid-call cost control (credit budget, call limits, optional cross-organization sharing). UNVERIFIED against any real provider's terms; sharing is OFF by default.
  const cost = costPolicy(env);
  const guard = new CostGuard(store, cost);
  const verification = new VerificationService(store, gate, verificationMetrics, { deadlineMs: 20_000, policy }, () => new Date(), Date.now, providerHealth, guard);
  const queue = new InProcessQueue();
  const bulk = new BulkService(store, checks, queue, limits, () => new Date(), verification);
  const portfolio = new PortfolioService(store, bulk, { freshMs: policy.freshMs, staleUsableMs: policy.staleUsableMs });
  const imports = new ImportService(store, bulk, queue, limits);
  queue.setHandler((orgId, jobId, kind) => (kind === "import" ? imports.process(orgId, jobId) : bulk.processJob(orgId, jobId)));
  const subs = new SubscriptionService(store);
  return {
    store, auth, provider, gate, limits, queue, bulk, imports, checks, subs, concerns: new ConcernService(store), audit: new AuditService(store), privacy: new VerificationPrivacyService(store), verification, verificationMetrics, costPolicy: cost, portfolio, alerts: new AlertService(store), reports: new ReportService(store, portfolio),
    orgs: new OrganizationService(store), team: new TeamService(store), clients: new ClientService(store),
    gstins: new GstinQueryService(store), returns: new ReturnsQueryService(store), dashboard: new DashboardService(store, subs),
  };
}

const g = globalThis as { __caContainer?: Container };
export const container = (): Container => (g.__caContainer ??= buildContainer());
export const resetContainer = () => { g.__caContainer = undefined; };
