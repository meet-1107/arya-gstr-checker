"use client";
import { useState } from "react";
import { Copy, Crown, MoreHorizontal, Plus, UserMinus, UserRoundPlus } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Alert, EmptyState, ErrorState, ProgressBar } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { ConfirmDialog, Dialog, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { formatDate, relativeTime } from "@/lib/client/format";
import { useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { SubscriptionOverview, TeamData } from "@/lib/client/types";
import type { Role } from "@/lib/permissions";

type Member = TeamData["members"][number];
type Invite = TeamData["invitations"][number];
const ROLE_TONE = { OWNER: "ink", ADMIN: "blue", ACCOUNTANT: "green", VIEWER: "neutral" } as const;
const label = (r: string) => r[0] + r.slice(1).toLowerCase();

/** Mirrors the server rules for button visibility only; the API enforces them independently. */
const canManage = (actor: Role | null, target: Role) => (actor === "OWNER" && target !== "OWNER") || (actor === "ADMIN" && (target === "ACCOUNTANT" || target === "VIEWER"));

function InviteDialog({ open, onOpenChange, actor }: { open: boolean; onOpenChange: (o: boolean) => void; actor: Role | null }) {
  const call = useApiCall(); const { toast } = useToast(); const invalidate = useInvalidate();
  const [email, setEmail] = useState(""); const [role, setRole] = useState("ACCOUNTANT");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [link, setLink] = useState<string | null>(null);
  const reset = (o: boolean) => { onOpenChange(o); if (!o) setTimeout(() => { setEmail(""); setLink(null); setErr(null); }, 200); };
  const send = async () => {
    setErr(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr("Enter a valid email address.");
    setBusy(true);
    try { const r = await call<{ token: string }>("/api/members", { method: "POST", body: { email, role } }); setLink(`${location.origin}/invite?token=${r.token}`); await invalidate("/api/members", "/api/subscription"); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={reset} title="Invite a team member" description="They'll share your clients, plan and GST check allowance." footer={link
      ? <Button variant="primary" onClick={() => reset(false)}>Done</Button>
      : <><Button variant="secondary" onClick={() => reset(false)} disabled={busy}>Cancel</Button><Button variant="primary" onClick={send} loading={busy}>Create invitation</Button></>}>
      {link ? (
        <div className="space-y-3">
          <Alert tone="success" title="Invitation created">Email delivery isn&apos;t set up yet. Copy this link and send it to <strong>{email}</strong>. It&apos;s shown only once and expires in 7 days.</Alert>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-muted p-2.5 pl-3"><p className="min-w-0 flex-1 truncate font-mono text-xs">{link}</p><Button size="sm" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(link); toast({ tone: "success", title: "Link copied" }); }}><Copy className="size-3.5" aria-hidden />Copy</Button></div>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {err && <Alert tone="danger">{err}</Alert>}
          <Field label="Email">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@firm.com" autoFocus />}</Field>
          <Field label="Role" hint={{ ADMIN: "Can manage clients, checks and team members (except owners and admins).", ACCOUNTANT: "Can manage clients, run checks and generate reports.", VIEWER: "Read-only access." }[role]}>
            {(p) => <Select {...p} value={role} onChange={(e) => setRole(e.target.value)}>{actor === "OWNER" && <option value="ADMIN">Admin</option>}<option value="ACCOUNTANT">Accountant</option><option value="VIEWER">Viewer</option></Select>}
          </Field>
          <button type="submit" className="hidden" />
        </form>
      )}
    </Dialog>
  );
}

export default function TeamPage() {
  const { can, role, user } = useSession();
  const call = useApiCall(); const { toast } = useToast(); const invalidate = useInvalidate();
  const team = useApi<TeamData>(can("team:manage") ? "/api/members" : null);
  const sub = useApi<{ subscription: SubscriptionOverview }>("/api/subscription");
  const [invite, setInvite] = useState(false);
  const [remove, setRemove] = useState<Member | null>(null);
  const [transfer, setTransfer] = useState<Member | null>(null);
  const [revoke, setRevoke] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const seats = sub.data?.subscription.seats;

  if (!can("team:manage")) return <><PageHeader title="Team" /><Alert tone="warning" title="You don't have access to team management">Ask an owner or admin of your organization.</Alert></>;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); await invalidate("/api/members", "/api/subscription"); toast({ tone: "success", title: ok }); } catch (e) { toast({ tone: "error", title: "Couldn't do that", description: errorMessage(e) }); } finally { setBusy(false); setRemove(null); setTransfer(null); setRevoke(null); }
  };

  const columns: Column<Member>[] = [
    { key: "who", header: "Member", primary: true, cell: (m) => <span className="flex items-center gap-3"><Avatar name={m.name} email={m.email} /><span className="min-w-0"><span className="block truncate font-medium">{m.name ?? m.email.split("@")[0]}{m.uid === user?.uid && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}</span><span className="block truncate text-xs font-normal text-muted">{m.email}</span></span></span> },
    { key: "role", header: "Role", cell: (m) => canManage(role, m.role) && m.uid !== user?.uid ? (
      <label className="block"><span className="sr-only">Role for {m.email}</span><Select className="!h-8 !py-0 text-[13px]" value={m.role} disabled={busy} onChange={(e) => void run(() => call(`/api/members/${m.uid}`, { method: "PATCH", body: { role: e.target.value } }), "Role updated")}>
        {role === "OWNER" && <option value="ADMIN">Admin</option>}<option value="ACCOUNTANT">Accountant</option><option value="VIEWER">Viewer</option>{!["ADMIN", "ACCOUNTANT", "VIEWER"].includes(m.role) && <option value={m.role}>{label(m.role)}</option>}</Select></label>
    ) : <Badge tone={ROLE_TONE[m.role]} icon={m.role === "OWNER" ? <Crown aria-hidden /> : undefined}>{label(m.role)}</Badge> },
    { key: "status", header: "Status", hideOnMobile: true, cell: () => <Badge tone="green">Active</Badge> },
    { key: "joined", header: "Joined", hideOnMobile: true, tabletHidden: true, cell: (m) => <span className="text-muted">{formatDate(m.addedAt)}</span> },
    { key: "active", header: "Last active", cell: (m) => <span className="text-muted">{m.lastActiveAt ? relativeTime(m.lastActiveAt) : "—"}</span> },
    { key: "act", header: "", align: "right", hideOnMobile: true, cell: (m) => (canManage(role, m.role) || (role === "OWNER" && m.role !== "OWNER")) && m.uid !== user?.uid ? (
      <Menu><MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-foreground" aria-label={`Actions for ${m.email}`}><MoreHorizontal className="size-4" /></MenuTrigger>
        <MenuContent>{role === "OWNER" && <MenuItem onSelect={() => setTransfer(m)}><Crown />Make owner…</MenuItem>}<MenuItem danger onSelect={() => setRemove(m)}><UserMinus />Remove from team</MenuItem></MenuContent></Menu>
    ) : null },
  ];
  const inviteCols: Column<Invite>[] = [
    { key: "email", header: "Email", primary: true, cell: (i) => i.email },
    { key: "role", header: "Role", cell: (i) => <Badge tone={ROLE_TONE[i.role]}>{label(i.role)}</Badge> },
    { key: "exp", header: "Expires", cell: (i) => (i.expired ? <Badge tone="amber">Expired</Badge> : <span className="text-muted">{formatDate(i.expiresAt)}</span>) },
    { key: "act", header: "", align: "right", cell: (i) => <Button size="sm" variant="ghost" onClick={() => setRevoke(i)}>Revoke</Button> },
  ];

  return (
    <>
      <PageHeader title="Team" description="Everyone here shares your firm's clients, plan and GST check allowance." actions={<Button variant="primary" onClick={() => setInvite(true)}><Plus className="size-4" aria-hidden />Invite member</Button>} />
      {seats && (
        <Card className="mb-6 p-5"><div className="flex items-center justify-between text-sm"><span className="font-medium">Team seats</span><span className="tabular text-muted">{seats.used} of {seats.limit ?? "custom"} used</span></div>
          {seats.limit !== null && <ProgressBar className="mt-3" value={seats.used} max={seats.limit} tone={seats.used >= seats.limit ? "amber" : "brand"} label="Team seats used" />}
          {seats.limit !== null && seats.used >= seats.limit && <p className="mt-2 text-xs text-muted">Your plan&apos;s seats are full (pending invitations count). Upgrade to add more people.</p>}</Card>
      )}
      <Card>
        {team.error && !team.data ? <ErrorState onRetry={() => void team.mutate()} detail={team.error.code} /> : <DataTable caption="Team members" columns={columns} rows={team.data?.members ?? []} rowKey={(m) => m.uid} loading={!team.data} skeletonRows={3} />}
      </Card>
      <h2 className="mb-3 mt-8 text-[15px] font-semibold">Pending invitations</h2>
      <Card>
        {team.data && team.data.invitations.length === 0 ? <EmptyState icon={<UserRoundPlus />} className="!py-10" title="No pending invitations" description="Invite colleagues to work on the same clients." />
          : <DataTable caption="Pending invitations" columns={inviteCols} rows={team.data?.invitations ?? []} rowKey={(i) => i.id} loading={!team.data} skeletonRows={2} />}
      </Card>

      <InviteDialog open={invite} onOpenChange={setInvite} actor={role} />
      <ConfirmDialog open={!!remove} onOpenChange={(o) => !o && setRemove(null)} variant="danger" confirmLabel="Remove" loading={busy} title={`Remove ${remove?.name ?? remove?.email}?`} description="They'll lose access to this organization immediately. Their past activity stays in the audit trail." onConfirm={async () => { if (remove) await run(() => call(`/api/members/${remove.uid}`, { method: "DELETE" }), "Member removed"); }} />
      <ConfirmDialog open={!!transfer} onOpenChange={(o) => !o && setTransfer(null)} confirmLabel="Transfer ownership" loading={busy} title={`Make ${transfer?.name ?? transfer?.email} the owner?`} description="They'll control billing and the team. You'll become an admin. There is always exactly one owner." onConfirm={async () => { if (transfer) await run(() => call("/api/members/transfer-ownership", { method: "POST", body: { uid: transfer.uid } }), "Ownership transferred"); }} />
      <ConfirmDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} variant="danger" confirmLabel="Revoke" loading={busy} title="Revoke this invitation?" description={`The link sent to ${revoke?.email} will stop working.`} onConfirm={async () => { if (revoke) await run(() => call(`/api/invitations/${revoke.id}`, { method: "DELETE" }), "Invitation revoked"); }} />
    </>
  );
}
