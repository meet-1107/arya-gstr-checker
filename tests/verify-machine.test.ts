import { describe, it, expect } from "vitest";
import {
  BUDGET, classifyNetwork, failureChecklist, failureOutcome, initialVerifyState, localInvalidView, progressAt, verifyReducer, type VerifyState,
} from "@/lib/client/verify-machine";
import { EXPLANATIONS } from "@/lib/verification";
import { gst } from "./helpers";

describe("progressAt — the wait is never unexplained", () => {
  it("walks the stages on the time budget", () => {
    expect(progressAt(0)).toEqual({ stage: "connecting", slow: false, giveUp: false });
    expect(progressAt(BUDGET.fetchingAt - 1).stage).toBe("connecting");
    expect(progressAt(BUDGET.fetchingAt).stage).toBe("fetching");
    expect(progressAt(BUDGET.processingAt).stage).toBe("processing");
  });
  it("flags slow at 5s and gives up at 25s (after the server's 20s deadline)", () => {
    expect(progressAt(4_999).slow).toBe(false);
    expect(progressAt(5_000).slow).toBe(true);
    expect(progressAt(BUDGET.giveUpAt - 1).giveUp).toBe(false);
    expect(progressAt(BUDGET.giveUpAt).giveUp).toBe(true);
    expect(BUDGET.giveUpAt).toBeGreaterThan(20_000);
  });
});

describe("classifyNetwork", () => {
  it("offline wins over everything", () => expect(classifyNetwork({ onLine: false, effectiveType: "4g" })).toBe("offline"));
  it("2g / very high latency / tiny bandwidth are weak (advisory)", () => {
    expect(classifyNetwork({ onLine: true, effectiveType: "2g" })).toBe("weak");
    expect(classifyNetwork({ onLine: true, effectiveType: "slow-2g" })).toBe("weak");
    expect(classifyNetwork({ onLine: true, rtt: 2000 })).toBe("weak");
    expect(classifyNetwork({ onLine: true, downlink: 0.05 })).toBe("weak");
  });
  it("unknown / healthy is online (missing Network Information API must not look weak)", () => {
    expect(classifyNetwork({})).toBe("online");
    expect(classifyNetwork({ onLine: true, effectiveType: "4g", rtt: 80, downlink: 10 })).toBe("online");
    expect(classifyNetwork({ onLine: true, downlink: 0 })).toBe("online");
  });
});

describe("verifyReducer", () => {
  const run = (s: VerifyState = initialVerifyState) => verifyReducer(s, { type: "START", gstin: gst(1), force: false, now: 1000 });
  it("start → tick → keep waiting → result", () => {
    let s = run();
    expect(s).toMatchObject({ status: "running", elapsedMs: 0, slowDismissed: false });
    s = verifyReducer(s, { type: "TICK", now: 7000 }); expect(s).toMatchObject({ elapsedMs: 6000 });
    s = verifyReducer(s, { type: "KEEP_WAITING" }); expect(s).toMatchObject({ slowDismissed: true });
    const view = { requestId: "r", gstin: gst(1), outcome: "ACTIVE", formatValid: true, freshness: "live", retryable: false, durationMs: 5 } as const;
    s = verifyReducer(s, { type: "RESULT", view }); expect(s).toEqual({ status: "done", view });
  });
  it("ticks and keep-waiting are ignored when nothing is running (late timers cannot resurrect state)", () => {
    expect(verifyReducer(initialVerifyState, { type: "TICK", now: 5 })).toBe(initialVerifyState);
    const failed = verifyReducer(run(), { type: "FAIL", gstin: gst(1), failure: { kind: "network" } });
    expect(verifyReducer(failed, { type: "TICK", now: 99999 })).toBe(failed);
    expect(verifyReducer(failed, { type: "KEEP_WAITING" })).toBe(failed);
  });
  it("a new START replaces a finished state; RESET returns to idle; elapsed never goes negative", () => {
    const done = verifyReducer(run(), { type: "RESULT", view: localInvalidView("x")! });
    expect(run(done).status).toBe("running");
    expect(verifyReducer(done, { type: "RESET" })).toEqual(initialVerifyState);
    expect(verifyReducer(run(), { type: "TICK", now: 1 })).toMatchObject({ elapsedMs: 0 });
  });
});

describe("local validation answers instantly, without a request", () => {
  it("returns an INVALID_GSTIN view with the reason", () => {
    expect(localInvalidView("")).toMatchObject({ outcome: "INVALID_GSTIN", invalidReason: "EMPTY", formatValid: false, requestId: "local" });
    expect(localInvalidView("abc")).toMatchObject({ invalidReason: "LENGTH" });
    const g = gst(1); expect(localInvalidView(g.slice(0, 14) + (g[14] === "A" ? "B" : "A"))).toMatchObject({ invalidReason: "CHECKSUM" });
  });
  it("returns null for a valid GSTIN (normalized: case/space)", () => {
    expect(localInvalidView(gst(3))).toBeNull(); expect(localInvalidView(` ${gst(3).toLowerCase()} `)).toBeNull();
  });
});

describe("client-side failures never accuse the GSTIN", () => {
  it("map to pipeline outcomes whose copy says it does not mean the GSTIN is fake", () => {
    for (const f of [{ kind: "offline" }, { kind: "network" }, { kind: "give_up" }, { kind: "http", status: 500, code: "X", message: "m" }] as const) {
      const o = failureOutcome(f);
      expect(["NETWORK_ERROR", "TIMEOUT", "PROVIDER_ERROR"]).toContain(o);
      expect(EXPLANATIONS[o].caveat).toMatch(/does not mean the GSTIN is fake/i);
    }
  });
  it("checklists always report the format as valid (it is checked before any request) and mark the true failing step", () => {
    expect(failureChecklist({ kind: "offline" }, "offline")).toEqual([{ label: "Your GSTIN format is valid", ok: true }, { label: "Your internet connection is available", ok: false }]);
    const gu = failureChecklist({ kind: "give_up" }, "online");
    expect(gu[0].ok).toBe(true); expect(gu.find((c) => /answered in time/.test(c.label))?.ok).toBe(false); expect(gu.find((c) => /internet/.test(c.label))?.ok).toBe(true);
    expect(failureChecklist({ kind: "network" }, "offline").find((c) => /internet/.test(c.label))?.ok).toBe(false);
  });
});

describe("stale-while-refresh transitions", () => {
  const view = (o: object = {}) => ({ requestId: "r", gstin: gst(1), outcome: "ACTIVE", formatValid: true, freshness: "cached", retryable: false, durationMs: 1, refreshRecommended: true, ...o }) as never;
  const live = view({ freshness: "live", refreshRecommended: undefined, requestId: "r2" });
  const done = () => verifyReducer(initialVerifyState, { type: "RESULT", view: view() });

  it("stored result on screen → refreshing → replaced by the live answer", () => {
    let s = verifyReducer(done(), { type: "REFRESH_START" });
    expect(s).toMatchObject({ status: "done", refresh: "running" });
    s = verifyReducer(s, { type: "REFRESH_OK", view: live });
    expect(s).toEqual({ status: "done", view: live, refresh: "updated" });
  });
  it("a failed refresh keeps the stored answer and says so", () => {
    const s = verifyReducer(verifyReducer(done(), { type: "REFRESH_START" }), { type: "REFRESH_FAIL" });
    expect(s).toMatchObject({ status: "done", refresh: "failed", view: { requestId: "r", freshness: "cached" } });
  });
  it("late or stray refresh results can never overwrite a newer state", () => {
    expect(verifyReducer(initialVerifyState, { type: "REFRESH_OK", view: live })).toBe(initialVerifyState);     // nothing on screen
    const idleDone = done();
    expect(verifyReducer(idleDone, { type: "REFRESH_OK", view: live })).toBe(idleDone);                          // refresh never started
    const running = verifyReducer(done(), { type: "REFRESH_START" });
    const newer = verifyReducer(running, { type: "START", gstin: gst(2), force: false, now: 1 });                // user searched again
    expect(verifyReducer(newer, { type: "REFRESH_OK", view: live })).toBe(newer);
    expect(verifyReducer(newer, { type: "REFRESH_FAIL" })).toBe(newer);
    const finished = verifyReducer(running, { type: "REFRESH_FAIL" });
    expect(verifyReducer(finished, { type: "REFRESH_OK", view: live })).toBe(finished);                          // already settled
  });
});
