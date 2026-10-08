import { ProviderError, type GstProvider, type GstinResult, type ReturnHistory } from "./types";
import { MockGstProvider } from "./mock";

/**
 * Placeholder adapters. Real GSTIN API / WhiteBooks integration is BLOCKED until
 * credentials, verified docs, pricing, rate limits and commercial terms are available.
 * They intentionally fail closed rather than guessing a vendor's API schema.
 */
class UnconfiguredProvider implements GstProvider {
  constructor(readonly name: string) {}
  private fail(): never {
    throw new ProviderError(
      "GST_PROVIDER_NOT_CONFIGURED",
      `GST provider "${this.name}" is not configured. Production credentials are required.`,
      false,
    );
  }
  async verifyGstin(): Promise<GstinResult> { return this.fail(); }
  async getReturnHistory(): Promise<ReturnHistory> { return this.fail(); }
}

export function createProvider(env: Record<string, string | undefined> = process.env): GstProvider {
  const name = (env.GST_PROVIDER ?? "mock").toLowerCase();
  const isProd = env.NODE_ENV === "production";
  if (name === "mock") {
    if (isProd && env.ALLOW_MOCK_IN_PRODUCTION !== "true-for-staging-only") {
      throw new ProviderError("GST_PROVIDER_NOT_CONFIGURED", "Mock GST provider is not allowed in production.", false);
    }
    // Dev/E2E-only scenario injection (comma-separated GSTINs). Never reachable in production without the staging override above.
    const set = (v?: string) => new Set((v ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
    const delay = Number(env.MOCK_DELAY_MS);
    return new MockGstProvider({ notFoundFor: set(env.MOCK_NOT_FOUND), failFor: set(env.MOCK_TIMEOUT), delayMs: Number.isFinite(delay) && delay > 0 ? delay : undefined });
  }
  if (name === "gstinapi" || name === "whitebooks") return new UnconfiguredProvider(name);
  throw new ProviderError("GST_PROVIDER_NOT_CONFIGURED", `Unknown GST provider "${name}".`, false);
}
