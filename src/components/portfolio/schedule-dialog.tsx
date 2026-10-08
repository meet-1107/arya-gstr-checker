"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { formatNumber } from "@/lib/client/format";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import { SCHEDULE_LABEL, type VerifySchedule } from "@/lib/portfolio";

type Choice = VerifySchedule | "off";
const OPTIONS: { value: Choice; label: string; hint: string }[] = [
  { value: "daily", label: "Daily", hint: "Check every day." },
  { value: "weekly", label: "Weekly", hint: "Check once a week." },
  { value: "monthly", label: "Monthly", hint: "Check about once a month." },
  { value: "off", label: "Off", hint: "Only verify when you ask." },
];

/** Scheduled re-verification for the chosen clients (or all). Answers that are still fresh are not looked up again. */
export function ScheduleDialog({ open, onOpenChange, clientIds, count }: { open: boolean; onOpenChange: (o: boolean) => void; clientIds: string[] | null; count: number }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Scheduled verification" description={clientIds ? `${formatNumber(clientIds.length)} selected client${clientIds.length === 1 ? "" : "s"}` : `All ${formatNumber(count)} clients`}>
      {open && <Body clientIds={clientIds} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function Body({ clientIds, onClose }: { clientIds: string[] | null; onClose: () => void }) {
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [choice, setChoice] = useState<Choice>("weekly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await call<{ updated: number }>("/api/portfolio/schedule", { method: "POST", body: { ...(clientIds ? { clientIds } : { all: true }), schedule: choice === "off" ? null : choice } });
      void invalidate("/api/portfolio");
      toast({ tone: "success", title: choice === "off" ? "Schedule turned off" : `${SCHEDULE_LABEL[choice]} verification set`, description: `${formatNumber(r.updated)} client${r.updated === 1 ? "" : "s"}` });
      onClose();
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">How often</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 hover:bg-surface-hover has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
            <input type="radio" name="schedule" className="mt-1 size-4 accent-primary" checked={choice === o.value} onChange={() => setChoice(o.value)} />
            <span><span className="block text-sm font-medium">{o.label}</span><span className="block text-xs text-muted">{o.hint}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-muted">Due clients are verified together in one background job. Anything verified recently is not looked up again, so a schedule never pays twice for a fresh answer. Each lookup still uses one of your plan&apos;s checks.</p>
      {error && <Alert tone="danger" title="Couldn't save">{error}</Alert>}
      <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
      </div>
    </div>
  );
}
