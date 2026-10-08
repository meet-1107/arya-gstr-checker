"use client";
import { useState, type FormEvent } from "react";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/components/session";
import { ApiError, errorMessage } from "@/lib/client/api";
import { useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { Client, SubscriptionOverview, TeamData } from "@/lib/client/types";
import { formatInr } from "@/lib/client/format";

/** Create (no `clientId`) or edit (with `clientId`; GSTIN is immutable by design). */
export function ClientFormDialog({ open, onOpenChange, clientId, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; clientId?: string; onSaved?: (c: Client) => void }) {
  const editing = !!clientId;
  const { can } = useSession();
  const call = useApiCall();
  const { toast } = useToast();
  const invalidate = useInvalidate();
  const existing = useApi<{ client: Client }>(open && clientId ? `/api/clients/${clientId}` : null);
  const members = useApi<TeamData>(open && can("team:manage") ? "/api/members" : null);
  const sub = useApi<{ subscription: SubscriptionOverview }>(open && !editing ? "/api/subscription" : null);
  const price = sub.data?.subscription.pricing;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={editing ? "Edit client" : "Add client"} description={editing ? "Update contact details and filing preferences." : "Add a client and their GSTIN to start monitoring."}>
      {!editing && price && !price.bill.custom && (
        price.nextClient.blocked
          ? <Alert tone="warning" title="You've reached this plan's client limit" className="mb-4">Archive a client or upgrade your plan to add another.</Alert>
          : price.nextClient.deltaInr > 0
            ? <Alert tone="info" title={`This adds ${formatInr(price.nextClient.deltaInr)} per ${price.period === "annual" ? "year" : "month"} to your bill`} className="mb-4">New total: <strong className="tabular">{formatInr(price.nextClient.newTotalInr)}</strong> per {price.period === "annual" ? "year" : "month"}. Archive clients you no longer manage to stop billing for them.</Alert>
            : null
      )}
      {editing && !existing.data ? <div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : (
        <Form
          key={existing.data?.client.id ?? "new"} initial={existing.data?.client} editing={editing}
          members={members.data?.members.map((m) => ({ uid: m.uid, label: m.name ?? m.email })) ?? null}
          onCancel={() => onOpenChange(false)}
          onSubmit={async (v) => {
            const body = Object.fromEntries(Object.entries(v).filter(([k, val]) => editing ? k !== "gstin" : true && (val !== "" || k === "notes")));
            const res = editing ? await call<{ client: Client }>(`/api/clients/${clientId}`, { method: "PATCH", body }) : await call<{ client: Client }>("/api/clients", { method: "POST", body });
            await invalidate("/api/clients", "/api/gstins", "/api/dashboard", "/api/subscription");
            toast({ tone: "success", title: editing ? "Client updated" : "Client added" });
            onSaved?.(res.client); onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

interface Values { name: string; gstin: string; email: string; phone: string; contactPerson: string; filingFrequency: string; assignedTo: string; notes: string }

function Form({ initial, editing, members, onSubmit, onCancel }: { initial?: Client; editing: boolean; members: { uid: string; label: string }[] | null; onSubmit: (v: Values) => Promise<void>; onCancel: () => void }) {
  const [v, setV] = useState<Values>({
    name: initial?.name ?? "", gstin: initial?.gstin ?? "", email: initial?.email ?? "", phone: initial?.phone ?? "", contactPerson: initial?.contactPerson ?? "",
    filingFrequency: initial?.filingFrequency ?? "MONTHLY", assignedTo: initial?.assignedTo ?? "", notes: initial?.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: "gstin" | "name" | "email"; msg: string } | null>(null);
  const set = (k: keyof Values) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!v.name.trim()) return setErr({ field: "name", msg: "Enter the client name." });
    if (!editing && v.gstin.trim().length !== 15) return setErr({ field: "gstin", msg: "A GSTIN has 15 characters." });
    setBusy(true);
    try { await onSubmit({ ...v, name: v.name.trim(), gstin: v.gstin.trim() }); }
    catch (x) {
      const code = x instanceof ApiError ? x.code : "";
      setErr(code === "INVALID_GSTIN" ? { field: "gstin", msg: "That GSTIN isn't valid. Check the characters and try again." }
        : code === "DUPLICATE_GSTIN" ? { field: "gstin", msg: "A client with this GSTIN already exists." }
        : code === "CLIENT_LIMIT_REACHED" ? { msg: `${errorMessage(x)} Upgrade your plan to add more.` } : { msg: errorMessage(x) });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {err && !err.field && <Alert tone="danger">{err.msg}</Alert>}
      <Field label="Client name" error={err?.field === "name" ? err.msg : null}>{(p) => <Input {...p} value={v.name} onChange={set("name")} autoFocus maxLength={200} />}</Field>
      <Field label="GSTIN" hint={editing ? "The GSTIN can't be changed. Delete and re-add the client if it was entered wrongly." : "15 characters"} error={err?.field === "gstin" ? err.msg : null}>
        {(p) => <Input {...p} className="font-mono uppercase" value={v.gstin} onChange={(e) => setV((s) => ({ ...s, gstin: e.target.value.toUpperCase() }))} maxLength={15} disabled={editing} spellCheck={false} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" optional>{(p) => <Input {...p} type="email" value={v.email} onChange={set("email")} />}</Field>
        <Field label="Phone" optional>{(p) => <Input {...p} type="tel" value={v.phone} onChange={set("phone")} maxLength={20} />}</Field>
        <Field label="Contact person" optional>{(p) => <Input {...p} value={v.contactPerson} onChange={set("contactPerson")} />}</Field>
        <Field label="Filing frequency">{(p) => <Select {...p} value={v.filingFrequency} onChange={set("filingFrequency")}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly (QRMP)</option></Select>}</Field>
      </div>
      {members && members.length > 0 && <Field label="Assigned to" optional>{(p) => <Select {...p} value={v.assignedTo} onChange={set("assignedTo")}><option value="">Unassigned</option>{members.map((m) => <option key={m.uid} value={m.uid}>{m.label}</option>)}</Select>}</Field>}
      <Field label="Notes" optional>{(p) => <Textarea {...p} value={v.notes} onChange={set("notes")} maxLength={2000} />}</Field>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end"><Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>{editing ? "Save changes" : "Add client"}</Button></div>
    </form>
  );
}
