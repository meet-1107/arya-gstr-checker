"use client";
import { useState, type FormEvent } from "react";
import { MapPin, Plus, Trash2 } from "lucide-react";
import { useSession } from "@/components/session";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/form";
import { ConfirmDialog, Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { relativeTime } from "@/lib/client/format";
import { useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { Client, SubscriptionOverview } from "@/lib/client/types";
import { cn } from "@/lib/cn";
import { panOf, stateNameOf } from "@/lib/client-gstins";
import { INVALID_REASON_TEXT } from "@/lib/verification";
import { validateGstin } from "@/lib/gstin";

interface Row { gstin: string; primary: boolean; state?: string; status: string; checked: boolean; lastCheckedAt?: string }

/**
 * The GSTINs of one client firm (one per state registration). The firm is ONE billing unit however many GSTINs it holds, up to the plan's
 * per-client limit. Selecting a GSTIN switches the detail view below; add/remove need clients:write.
 */
export function ClientGstins({ client, selected, onSelect }: { client: Client; selected: string; onSelect: (gstin: string) => void }) {
  const { can } = useSession();
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const list = useApi<{ gstins: Row[] }>(`/api/clients/${client.id}/gstins`);
  const sub = useApi<{ subscription: SubscriptionOverview }>("/api/subscription");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = list.data?.gstins ?? [];
  const limit = sub.data?.subscription.plan.gstinsPerClient ?? null;
  const planName = sub.data?.subscription.plan.name;
  const write = can("clients:write") && client.status !== "archived";
  const atLimit = limit !== null && rows.length >= limit;

  const refresh = () => Promise.all([list.mutate(), invalidate(`/api/clients/${client.id}`, "/api/gstins", "/api/dashboard", "/api/portfolio")]);

  return (
    <Card className="mb-6">
      <CardHeader
        title="GSTINs"
        description={`One client firm, ${rows.length || "…"} GSTIN${rows.length === 1 ? "" : "s"}${limit !== null ? ` of ${limit} allowed on ${planName ?? "your plan"}` : ""}. Adding a GSTIN doesn't change your bill.`}
        action={write && <Button size="sm" variant="secondary" disabled={atLimit} onClick={() => setAdding(true)} title={atLimit ? `Your plan allows ${limit} GSTIN${limit === 1 ? "" : "s"} per client firm` : undefined}><Plus className="size-4" aria-hidden />Add GSTIN</Button>}
      />
      <CardBody>
        {list.isLoading ? <Skeleton className="h-16" /> : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="GSTINs of this client">
            {rows.map((r) => (
              <li key={r.gstin} className={cn("flex items-stretch rounded-lg border", r.gstin === selected ? "border-primary ring-1 ring-primary" : "border-line")}>
                <button type="button" onClick={() => onSelect(r.gstin)} aria-pressed={r.gstin === selected} className="min-w-0 flex-1 rounded-lg p-3 text-left hover:bg-surface-hover">
                  <span className="flex items-center gap-1.5 text-xs text-muted"><MapPin className="size-3.5" aria-hidden />{r.state ?? "State code " + r.gstin.slice(0, 2)}{r.primary && <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground">Primary</span>}</span>
                  <span className="mt-1 block truncate font-mono text-[13px] font-medium">{r.gstin}</span>
                  <span className="mt-1.5 flex items-center gap-2 text-xs text-muted"><StatusBadge status={r.status} />{r.lastCheckedAt ? relativeTime(r.lastCheckedAt) : "Not checked"}</span>
                </button>
                {write && !r.primary && (
                  <button type="button" onClick={() => setRemoving(r)} aria-label={`Remove GSTIN ${r.gstin}`} className="shrink-0 rounded-r-lg px-2.5 text-muted hover:bg-surface-hover hover:text-danger-strong"><Trash2 className="size-4" aria-hidden /></button>
                )}
              </li>
            ))}
          </ul>
        )}
        {atLimit && write && <p className="mt-3 text-xs text-muted">This is the most GSTINs your {planName ?? ""} plan allows per client firm. Upgrade to add more.</p>}
      </CardBody>

      <AddGstinDialog open={adding} onOpenChange={setAdding} client={client} existing={rows.map((r) => r.gstin)} onAdded={async (g) => { await refresh(); onSelect(g); }} />
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} variant="danger" confirmLabel="Remove GSTIN" loading={busy}
        title={`Remove ${removing?.gstin ?? "GSTIN"}?`} description="Its stored status and return history are deleted. The client and its other GSTINs are not affected."
        onConfirm={async () => {
          if (!removing) return; setBusy(true);
          try {
            await call(`/api/clients/${client.id}/gstins/${removing.gstin}`, { method: "DELETE" });
            if (selected === removing.gstin) onSelect(client.gstin);
            await refresh(); toast({ tone: "success", title: "GSTIN removed", description: removing.gstin }); setRemoving(null);
          } catch (e) { toast({ tone: "error", title: "Couldn't remove it", description: errorMessage(e) }); } finally { setBusy(false); }
        }} />
    </Card>
  );
}

function AddGstinDialog({ open, onOpenChange, client, existing, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; client: Client; existing: string[]; onAdded: (gstin: string) => Promise<void> }) {
  const call = useApiCall(); const { toast } = useToast();
  const [text, setText] = useState("");
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const g = text.trim().toUpperCase().replace(/\s+/g, "");
  const v = g.length === 15 ? validateGstin(g) : null;
  // Instant, local feedback for everything the server will also check (the server remains the authority).
  const hint = v && !v.valid ? INVALID_REASON_TEXT[v.reason]
    : v && v.valid && panOf(v.gstin) !== panOf(client.gstin) ? `This GSTIN has a different PAN (${panOf(v.gstin)}). GSTINs of one client firm share PAN ${panOf(client.gstin)}; add a different PAN as its own client.`
    : v && v.valid && existing.includes(v.gstin) ? "This GSTIN is already on this client." : null;
  const ok = !!v && v.valid && !hint;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!ok) return; setBusy(true); setServerErr(null);
    try { await call(`/api/clients/${client.id}/gstins`, { method: "POST", body: { gstin: g } }); toast({ tone: "success", title: "GSTIN added", description: `${g}${stateNameOf(g) ? ` · ${stateNameOf(g)}` : ""}` }); await onAdded(g); setText(""); onOpenChange(false); }
    catch (x) { setServerErr(errorMessage(x)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add a GSTIN" description={`Another state registration of ${client.name}. It must have the same PAN (${panOf(client.gstin)}).`}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="GSTIN" hint={v && v.valid && !hint ? `${stateNameOf(g) ?? "Unknown state"} · PAN matches` : "15 characters"} error={hint ?? serverErr}>
          {(p) => <Input {...p} className="font-mono uppercase" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} placeholder={`e.g. 27${panOf(client.gstin)}1Z5`} maxLength={20} autoComplete="off" autoCapitalize="characters" spellCheck={false} />}
        </Field>
        {serverErr && hint && <Alert tone="danger">{serverErr}</Alert>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!ok}>Add GSTIN</Button></div>
      </form>
    </Dialog>
  );
}
