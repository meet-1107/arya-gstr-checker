"use client";
import { useState } from "react";
import { ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import { useSession } from "@/components/session";

/** What is stored about lookups, who can see it, and how to remove it. Statements here must stay true to the code (see tests/trust.test.ts). */
export function PrivacyPanel() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { can } = useSession(); const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const clear = async () => {
    setBusy(true);
    try { const r = await call<{ removed: number }>("/api/verify/history", { method: "DELETE" }); await invalidate("/api/verify/recent", "/api/audit-logs"); toast({ tone: "success", title: "History cleared", description: `${r.removed} stored lookup${r.removed === 1 ? "" : "s"} removed.` }); setConfirm(false); setOpen(false); }
    catch (e) { toast({ tone: "error", title: "Couldn't clear history", description: errorMessage(e) }); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><ShieldCheck className="size-3.5" aria-hidden />Privacy &amp; data</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Privacy & data" description="What happens to the GSTINs you look up." size="md"
        footer={<>
          {can("auditlog:read") && <Button variant="danger" onClick={() => setConfirm(true)}><Trash2 className="size-4" aria-hidden />Clear verification history</Button>}
          <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
        </>}>
        <div className="space-y-3 text-sm">
          <p><span className="font-medium">What we keep:</span> for each GSTIN your organization verifies — the registry answer (status and public registration details), when and from which source it was obtained, who ran it, and any notes, tags or pin your team adds. Failed lookups are not stored as answers.</p>
          <p><span className="font-medium">Who can see it:</span> members of your organization (viewers can read the history; only accountants and above can run lookups or edit notes). It is not visible to other organizations.</p>
          <p><span className="font-medium">Shared results:</span> where shared caching is enabled, the public registry answer for a GSTIN may be reused for other organizations. That shared copy contains no organization, user, note or tag information.</p>
          <p><span className="font-medium">Audit trail:</span> owners and admins can see that a lookup, save, note edit or removal happened — never the text of your notes.</p>
          <p><span className="font-medium">Your controls:</span> remove any one lookup from the history list (the × on its row; this also deletes its notes, tags and pin). Owners and admins can clear the whole history. Removing a lookup makes the next check of that GSTIN a fresh live check.</p>
          <p className="text-xs text-muted">Concerns you report are kept separately as internal records for your organization; they are not removed when history is cleared. Stored answers are kept until removed — there is no automatic expiry yet.</p>
        </div>
      </Dialog>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Clear all verification history?" variant="danger" confirmLabel="Clear history" loading={busy} onConfirm={clear}
        description="Every stored lookup for your organization is removed, with its notes, tags and pins. Concerns and the audit trail are kept. This can't be undone." />
    </>
  );
}

/** × on a history row: removes that one stored lookup. */
export function ForgetButton({ gstin, onDone }: { gstin: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const call = useApiCall(); const { toast } = useToast();
  return (
    <button type="button" disabled={busy} aria-label={`Remove ${gstin} from history`} title="Remove from history"
      className="mr-2 shrink-0 rounded-lg p-2 text-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50 sm:mr-3"
      onClick={async () => { setBusy(true); try { await call("/api/verify/forget", { method: "POST", body: { gstin } }); onDone(); toast({ tone: "success", title: "Removed from history", description: gstin }); } catch (e) { toast({ tone: "error", title: "Couldn't remove", description: errorMessage(e) }); } finally { setBusy(false); } }}>
      <X className="size-4" aria-hidden />
    </button>
  );
}
