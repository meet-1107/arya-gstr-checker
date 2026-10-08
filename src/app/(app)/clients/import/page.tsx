"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ImportWizard } from "@/components/imports/import-wizard";
import { ImportHistory } from "@/components/imports/import-ui";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Alert } from "@/components/ui/feedback";

export default function ImportPage() {
  const { can } = useSession();
  return (
    <>
      <Link href="/clients" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />Clients</Link>
      <PageHeader title="Import clients" description="Add many clients at once from a CSV. We validate every GSTIN and show you what will happen before anything is saved." />
      {can("imports:run") ? <ImportWizard /> : <Alert tone="info" title="Your role is read-only">Accountants, admins and owners can import clients. You can still see past imports below.</Alert>}
      <div className="mt-10"><ImportHistory /></div>
    </>
  );
}
