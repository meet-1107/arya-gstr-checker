import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { ProviderError } from "@/providers/types";
import { ForbiddenError } from "@/lib/permissions";
import { extractGstins } from "@/lib/gstin-extract";
import { buildShareText, freshnessLine, formatIst, isShareable, mailtoUrl, shareLines, whatsappUrl } from "@/lib/share";
import { readScan, cameraFailure, CAMERA_FAILURE_TEXT } from "@/lib/client/scan";
import type { VerificationView } from "@/lib/verification";
import { ctxFor, FAST_LIMITS, gst, NOW, seedOrg, StubProvider } from "./helpers";

describe("extractGstins", () => {
  const g = gst(1), h = gst(2);
  it("finds a GSTIN inside invoice-like text, any case", () => {
    expect(extractGstins(`Supplier GSTIN: ${g.toLowerCase()}, Invoice 42`).valid).toEqual([g]);
    expect(extractGstins(`GSTIN/UIN:${g}\nPlace of supply 24`).valid).toEqual([g]);
  });
  it("finds several, de-duplicated, in order", () => {
    expect(extractGstins(`${h} then ${g} and ${h} again`).valid).toEqual([h, g]);
  });
  it("handles GSTINs typed in groups or with dashes", () => {
    expect(extractGstins(`${g.slice(0, 7)} ${g.slice(7)}`).valid).toEqual([g]);
    expect(extractGstins(`${g.slice(0, 2)}-${g.slice(2, 12)}-${g.slice(12)}`).valid).toEqual([g]);
  });
  it("reports checksum failures separately and never fixes them", () => {
    const bad = g.slice(0, 14) + (g[14] === "A" ? "B" : "A");
    expect(extractGstins(`x ${bad} y`)).toEqual({ valid: [], invalid: [bad] });
  });
  it("does not match inside longer alphanumeric runs", () => {
    expect(extractGstins(`X${g}Y`).valid).toEqual([]);
    expect(extractGstins("").valid).toEqual([]); expect(extractGstins("no gstin here 12345").valid).toEqual([]);
  });
  it("reads URL-encoded and JSON QR payloads", () => {
    expect(extractGstins(`https://example.test/v?gstin=${g}&x=1`).valid).toEqual([g]);
    expect(extractGstins(JSON.stringify({ SellerGstin: g, BuyerGstin: h, DocNo: "1" })).valid).toEqual([g, h]);
    expect(extractGstins(encodeURIComponent(`{"gstin":"${g}"}`)).valid).toEqual([g]);
  });
  it("reads the e-invoice QR (a JWT whose payload embeds the seller/buyer GSTIN)", () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ data: JSON.stringify({ SellerGstin: g, BuyerGstin: h }), iss: "NIC" })}.sig_nature-xx`;
    expect(extractGstins(jwt).valid).toEqual([g, h]);
  });
  it("is bounded (huge input, many candidates)", () => {
    const many = Array.from({ length: 200 }, (_, i) => gst(i + 1)).join(" ");
    expect(extractGstins(many, 5).valid.length).toBeLessThanOrEqual(5);
    expect(() => extractGstins("A".repeat(1_000_000))).not.toThrow();
  });
});

describe("readScan", () => {
  it("returns the first valid GSTIN and the others", () => {
    expect(readScan(["junk", `a ${gst(3)} b ${gst(4)}`])).toEqual({ kind: "gstin", gstin: gst(3), others: [gst(4)] });
  });
  it("distinguishes no GSTIN in this QR from a checksum failure", () => {
    expect(readScan(["https://example.test/menu"])).toEqual({ kind: "no_gstin" });
    const bad = gst(3).slice(0, 14) + (gst(3)[14] === "A" ? "B" : "A");
    expect(readScan([bad])).toEqual({ kind: "bad_checksum" });
    expect(readScan([])).toEqual({ kind: "no_gstin" });
  });
  it("every camera failure has an explanation that offers the manual path", () => {
    for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "Weird"]) expect(CAMERA_FAILURE_TEXT[cameraFailure({ name })]).toMatch(/type|enter/i);
    expect(cameraFailure(null)).toBe("unknown");
  });
});

describe("share text", () => {
  const view = (o: Partial<VerificationView> = {}): VerificationView => ({
    requestId: "r", gstin: gst(1), outcome: "ACTIVE", formatValid: true, freshness: "live", ageSeconds: 0, retryable: false, durationMs: 1, source: "gstn",
    verifiedAt: "2026-10-06T08:44:00.000Z", details: { legalName: "ABC INDUSTRIES PVT LTD", tradeName: "ABC INDUSTRIES", state: "Gujarat", taxpayerType: "Regular" }, ...o,
  });
  it("only registry status answers are shareable", () => {
    expect(isShareable(view())).toBe(true);
    for (const outcome of ["NOT_FOUND", "INVALID_GSTIN", "TIMEOUT", "MAINTENANCE", "NETWORK_ERROR"] as const) expect(isShareable(view({ outcome, freshness: "none" }))).toBe(false);
    expect(buildShareText({ view: view({ outcome: "TIMEOUT", freshness: "none" }), appName: "App" })).toBe("");
  });
  it("includes status, name, GSTIN, IST time and the status-can-change disclaimer", () => {
    const t = buildShareText({ view: view(), appName: "GST Workspace" });
    expect(t).toContain(`GSTIN: ${gst(1)}`); expect(t).toContain("Status: Active"); expect(t).toContain("Legal name: ABC INDUSTRIES PVT LTD");
    expect(t).toContain("Trade name: ABC INDUSTRIES"); expect(t).toContain("State: Gujarat"); expect(t).toContain("Verified live on");
    expect(t).toMatch(/2:14 pm IST/); expect(t).toContain("verify again before relying on it");
  });
  it("labels stored results with their age, and mock data as mock", () => {
    const stored = buildShareText({ view: view({ freshness: "cached", ageSeconds: 18 * 60, source: "mock" }), appName: "A" });
    expect(stored).toContain("Stored result, verified 18 minutes ago"); expect(stored).toContain("MOCK DATA");
    expect(freshnessLine(view({ freshness: "cached", ageSeconds: 7200 }))).toContain("2 hours ago");
  });
  it("omits a trade name equal to the legal name; times are IST regardless of locale", () => {
    expect(shareLines(view({ details: { legalName: "X", tradeName: "X" } })).some((l) => l.label === "Trade name")).toBe(false);
    expect(formatIst("2026-10-06T18:30:00.000Z")).toMatch(/7 Oct 2026, 12:00 am/);
  });
  it("builds safe, encoded links", () => {
    const text = "a b & c=1\nline2";
    expect(whatsappUrl(text)).toBe(`https://wa.me/?text=${encodeURIComponent(text)}`);
    expect(mailtoUrl("S&S", text)).toContain("subject=S%26S");
  });
});

describe("saved GSTINs (service)", () => {
  let store: MemoryStore, provider: StubProvider, clock: Date, svc: VerificationService;
  const A = ctxFor("a", "ACCOUNTANT");
  beforeEach(async () => {
    store = new MemoryStore(); provider = new StubProvider(() => clock); clock = new Date(NOW);
    await seedOrg(store, "a"); await seedOrg(store, "b");
    svc = new VerificationService(store, new ResilientProvider(provider, FAST_LIMITS, { sleep: async () => {} }), new VerificationMetrics(), DEFAULT_VERIFY_OPTIONS, () => clock);
  });
  it("save requires a prior verification, a valid GSTIN and a boolean", async () => {
    await expect(svc.setSaved(A, gst(1), true)).rejects.toMatchObject({ code: "VERIFICATION_NOT_FOUND", status: 404 });
    await expect(svc.setSaved(A, "bad", true)).rejects.toMatchObject({ code: "INVALID_GSTIN" });
    await expect(svc.setSaved(A, gst(1), "yes")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("save, list under saved, survive cached and live re-verification, unsave removes", async () => {
    await svc.verify(A, gst(1)); await svc.verify(A, gst(2));
    expect(await svc.setSaved(A, gst(1), true)).toEqual({ gstin: gst(1), saved: true });
    expect((await svc.recent(A, 10, { saved: true })).map((r) => r.gstin)).toEqual([gst(1)]);
    expect((await svc.verify(A, gst(1))).saved).toBe(true);
    expect((await svc.verify(A, gst(1), { force: true })).saved).toBe(true);
    expect(await svc.recent(A, 10, { saved: true })).toHaveLength(1);
    expect((await svc.recent(A)).find((r) => r.gstin === gst(2))?.saved).toBe(false);
    await svc.setSaved(A, gst(1), false);
    expect(await svc.recent(A, 10, { saved: true })).toEqual([]);
  });
  it("a NOT_FOUND replacement keeps the saved flag", async () => {
    await svc.verify(A, gst(1)); await svc.setSaved(A, gst(1), true);
    provider.failFor.set(gst(1), new ProviderError("GST_PROVIDER_NOT_FOUND", "x", false));
    await svc.verify(A, gst(1), { force: true });
    expect((await svc.recent(A, 10, { saved: true }))[0]).toMatchObject({ gstin: gst(1), outcome: "NOT_FOUND" });
  });
  it("is per organization and needs checks:run to change; anyone can read", async () => {
    await svc.verify(A, gst(1)); await svc.setSaved(A, gst(1), true);
    expect(await svc.recent(ctxFor("b", "OWNER"), 10, { saved: true })).toEqual([]);
    await expect(svc.setSaved(ctxFor("b", "OWNER"), gst(1), true)).rejects.toMatchObject({ code: "VERIFICATION_NOT_FOUND" });
    await expect(svc.setSaved(ctxFor("a", "VIEWER"), gst(1), false)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await svc.recent(ctxFor("a", "VIEWER"), 10, { saved: true })).length).toBe(1);
  });
});
