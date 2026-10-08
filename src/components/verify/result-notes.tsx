"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { NotebookPen, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import { isShareable } from "@/lib/share";
import type { VerificationView } from "@/lib/verification";

const MAX_NOTE = 500, MAX_TAGS = 5, MAX_TAG_LEN = 24;

/** Private-to-the-organization note and labels (labels double as folders: filter the Saved list by them). */
export function NotesEditor({ view, canEdit }: { view: VerificationView; canEdit: boolean }) {
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(view.note ?? "");
  const [tags, setTags] = useState((view.tags ?? []).join(", "));
  const [saved, setSaved] = useState({ note: view.note ?? "", tags: view.tags ?? [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const panel = useId();
  if (!isShareable(view)) return null; // only a stored registry answer can carry notes

  const parsedTags = [...new Set(tags.split(",").map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean))];
  const invalid = parsedTags.length > MAX_TAGS ? `Use at most ${MAX_TAGS} tags.` : parsedTags.some((t) => t.length > MAX_TAG_LEN) ? `Tags can be at most ${MAX_TAG_LEN} characters.` : note.length > MAX_NOTE ? `Notes can be at most ${MAX_NOTE} characters.` : null;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await call<{ note?: string; tags: string[] }>("/api/verify/annotate", { method: "POST", body: { gstin: view.gstin, note, tags: parsedTags } });
      setSaved({ note: r.note ?? "", tags: r.tags }); setNote(r.note ?? ""); setTags(r.tags.join(", "));
      void invalidate("/api/verify/recent");
      toast({ tone: "success", title: "Notes saved" }); setOpen(false);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const count = saved.tags.length + (saved.note ? 1 : 0);
  return (
    <div className="w-full">
      <Button size="sm" variant="secondary" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
        <NotebookPen className="size-3.5" aria-hidden />Notes &amp; tags{count ? ` (${count})` : ""}
      </Button>
      {!open && (saved.tags.length > 0 || saved.note) && (
        <div className="mt-2 text-[13px]">
          {saved.tags.length > 0 && <p className="flex flex-wrap gap-1.5">{saved.tags.map((t) => <span key={t} className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium">{t}</span>)}</p>}
          {saved.note && <p className="mt-1.5 whitespace-pre-wrap text-muted">{saved.note}</p>}
        </div>
      )}
      {open && (
        <div id={panel} className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3">
          <div>
            <label htmlFor={`${panel}-tags`} className="text-[13px] font-medium">Tags <span className="font-normal text-muted">(comma-separated, up to {MAX_TAGS})</span></label>
            <input id={`${panel}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} disabled={!canEdit} placeholder="e.g. Monthly filer, Gujarat, Review in March"
              className="mt-1.5 h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm shadow-card placeholder:text-subtle hover:border-muted focus-visible:border-info disabled:bg-surface-muted" />
          </div>
          <div>
            <label htmlFor={`${panel}-note`} className="text-[13px] font-medium">Note <span className="font-normal text-muted">(visible to your whole organization)</span></label>
            <textarea id={`${panel}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} disabled={!canEdit}
              className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm shadow-card hover:border-muted focus-visible:border-info disabled:bg-surface-muted" />
            <p className="mt-1 text-xs text-muted">{note.length}/{MAX_NOTE}</p>
          </div>
          {(invalid || err) && <p role="alert" className="text-xs text-danger-strong">{invalid ?? err}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={busy} disabled={!canEdit || !!invalid} onClick={() => void save()}>Save notes</Button>
            <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setNote(saved.note); setTags(saved.tags.join(", ")); setErr(null); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Turns a verified GSTIN into a client record (name prefilled from the registry) so it joins monitoring, returns and reports. */
export function AddClientButton({ view, canAdd }: { view: VerificationView; canAdd: boolean }) {
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!canAdd || !isShareable(view) || view.outcome === "NOT_FOUND") return null;
  if (done) return <Link href="/clients" className="text-[13px] font-medium underline">Added — view clients</Link>;
  const add = async () => {
    setBusy(true);
    try {
      await call("/api/clients", { method: "POST", body: { name: view.details?.legalName ?? view.details?.tradeName ?? view.gstin, gstin: view.gstin } });
      await invalidate("/api/clients", "/api/gstins", "/api/dashboard"); setDone(true);
      toast({ tone: "success", title: "Added as a client", description: view.details?.legalName ?? view.gstin });
    } catch (e) {
      const m = errorMessage(e);
      toast({ tone: /already exists/i.test(m) ? "info" : "error", title: /already exists/i.test(m) ? "Already a client" : "Couldn't add client", description: /already exists/i.test(m) ? view.gstin : m });
    } finally { setBusy(false); }
  };
  return <Button size="sm" variant="secondary" loading={busy} onClick={() => void add()}><UserPlus className="size-3.5" aria-hidden />Add as client</Button>;
}
