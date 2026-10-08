"use client";
import { useId, useState } from "react";
import { Flag, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import dynamic from "next/dynamic";
const ConcernDialog = dynamic(() => import("./concern-dialog").then((m) => m.ConcernDialog), { ssr: false }); // opened rarely
import { formatIst } from "@/lib/share";
import { ageLabel, EXPLANATIONS, type VerificationView } from "@/lib/verification";

const HOW: Record<string, string> = {
  LIVE_PROVIDER: "Fetched from the GST data provider while you waited.",
  CACHE: "Served from your organization's stored result; no new lookup was made.",
  SHARED_CACHE: "Served from a recent shared result; no new lookup was made for you.",
  DEDUPED: "Another lookup of this GSTIN was already in progress; you received its result.",
  BATCH: "Obtained as part of a bulk run.",
};

/** "About this result": where the answer came from and what it does and does not tell you. Only facts the response actually carries. */
export function AboutResult({ view }: { view: VerificationView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const e = EXPLANATIONS[view.outcome];
  return (
    <div className={open ? "w-full" : undefined}>
      <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}><Info className="size-3.5" aria-hidden />About this result</Button>
      {open && (
        <dl id={id} className="mt-2 grid gap-x-6 gap-y-2.5 rounded-lg border border-line bg-surface p-3 text-[13px] sm:grid-cols-2">
          <div><dt className="text-xs text-muted">Source</dt><dd className="font-medium">{view.source === "mock" ? "Mock data (development) — not a real registry answer" : view.source ?? "—"}</dd></div>
          <div><dt className="text-xs text-muted">Answer obtained</dt><dd className="font-medium">{view.verifiedAt ? `${formatIst(view.verifiedAt)} IST${view.freshness === "cached" ? ` (${ageLabel(view.ageSeconds ?? 0)})` : ""}` : "—"}</dd></div>
          <div><dt className="text-xs text-muted">How we got it</dt><dd className="font-medium">{view.provenance ? HOW[view.provenance] ?? view.provenance : view.freshness === "live" ? HOW.LIVE_PROVIDER : view.freshness === "cached" ? HOW.CACHE : "No registry answer in this response."}</dd></div>
          <div><dt className="text-xs text-muted">Reference</dt><dd className="break-all font-mono text-xs">{view.requestId}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-muted">What this means</dt><dd>{e.meaning}{e.caveat ? ` ${e.caveat}` : ""}</dd></div>
        </dl>
      )}
      {open && <p className="mt-2 text-xs text-muted">Registration status can change at any time. This is information from the data source named above, not legal advice or an endorsement of the business.</p>}
    </div>
  );
}

/** Opens the internal "report a concern" form. Shown for any registry answer, including "no matching registration". */
export function ReportConcernButton({ view, canReport }: { view: VerificationView; canReport: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canReport || (view.freshness === "none" && view.outcome !== "NOT_FOUND")) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Flag className="size-3.5" aria-hidden />Report a concern</Button>
      {open && <ConcernDialog gstin={view.gstin} onClose={() => setOpen(false)} />}
    </>
  );
}

