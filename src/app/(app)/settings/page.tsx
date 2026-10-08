"use client";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert } from "@/components/ui/feedback";

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex items-center justify-between gap-4 border-b border-line py-3 text-sm last:border-0"><dt className="text-muted">{k}</dt><dd className="min-w-0 truncate text-right font-medium">{v}</dd></div>;

export default function SettingsPage() {
  const { user, activeOrg, orgs, authMode } = useSession();
  return (
    <>
      <PageHeader title="Settings" description="Your account and organization." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" />
          <CardBody>
            <div className="mb-4 flex items-center gap-3"><Avatar name={user?.name} email={user?.email} size="lg" /><div className="min-w-0"><p className="truncate font-medium">{user?.name ?? "—"}</p><p className="truncate text-sm text-muted">{user?.email}</p></div></div>
            <dl>
              <Row k="Email verified" v={user?.emailVerified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Not verified</Badge>} />
              <Row k="Sign-in method" v={authMode === "dev" ? <Badge tone="amber">Development (local)</Badge> : "Firebase"} />
              <Row k="Organizations" v={orgs.length} />
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Organization" />
          <CardBody>
            <dl>
              <Row k="Name" v={activeOrg?.name ?? "—"} />
              <Row k="Your role" v={<span className="capitalize">{activeOrg?.role.toLowerCase()}</span>} />
              <Row k="Plan" v={<span className="capitalize">{activeOrg?.plan}</span>} />
              <Row k="Status" v={<span className="capitalize">{activeOrg?.status}</span>} />
            </dl>
            <Alert tone="info" className="mt-4">Editing organization details, notification preferences and data export are coming next.</Alert>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
