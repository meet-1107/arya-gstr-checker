"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { Alert } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { useApiCall } from "@/lib/client/hooks";
import { CONCERN_CATEGORIES, CONCERN_DISCLAIMER, MAX_DESCRIPTION, MIN_DESCRIPTION } from "@/lib/concerns";

export function ConcernDialog({ gstin, onClose }: { gstin: string; onClose: () => void }) {
  const call = useApiCall(); const { toast } = useToast();
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tooShort = description.trim().length < MIN_DESCRIPTION;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await call<{ duplicate: boolean }>("/api/concerns", { method: "POST", body: { gstin, category, description } });
      toast({ tone: "success", title: r.duplicate ? "Already reported" : "Concern recorded", description: r.duplicate ? "An identical open concern from you already exists." : "Visible to your organization's team." });
      onClose();
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Report a concern" description={`About ${gstin}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={!category || tooShort} onClick={() => void submit()}>Record concern</Button></>}>
      <div className="space-y-4">
        <Alert tone="info">{CONCERN_DISCLAIMER}</Alert>
        <fieldset>
          <legend className="text-[13px] font-medium">What looks wrong?</legend>
          <div className="mt-2 space-y-1.5">
            {CONCERN_CATEGORIES.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line p-2.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
                <input type="radio" name="concern-category" value={c.id} checked={category === c.id} onChange={() => setCategory(c.id)} className="mt-0.5 size-4 accent-primary" />
                <span><span className="font-medium">{c.label}</span><span className="block text-xs text-muted">{c.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="concern-desc" className="text-[13px] font-medium">What did you notice?</label>
          <textarea id="concern-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={MAX_DESCRIPTION + 200}
            className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm shadow-card hover:border-muted focus-visible:border-info" aria-describedby="concern-desc-hint" />
          <p id="concern-desc-hint" className="mt-1 text-xs text-muted">{description.trim().length}/{MAX_DESCRIPTION} · at least {MIN_DESCRIPTION} characters. Don&apos;t paste passwords or card numbers.</p>
        </div>
        {err && <p role="alert" className="text-xs text-danger-strong">{err}</p>}
      </div>
    </Dialog>
  );
}
