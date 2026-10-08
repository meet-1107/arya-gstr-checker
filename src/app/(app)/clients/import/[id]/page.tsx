"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Download, ListChecks, Users } from "lucide-react";
import { ImportStatusBadge, ProgressLine, isImportActive } from "@/components/imports/import-ui";
import { useSession } from "@/components/session";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, ErrorState, Skeleton } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { apiDownload, errorMessage, saveFile } from "@/lib/client/api";
import { formatDateTime, formatNumber } from "@/lib/client/format";
import { useApi, useApiCall } from "@/lib/client/hooks";
import { verifyErrorText } from "@/lib/client/import-wizard";
import type { ImportView } from "@/lib/client/types";

export default function ImportResultPage() {
  const { id } = useParams<{ id: string }>();
  const { can, activeOrgId } = useSession();
  const call = useApiCall();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error, mutate } = useApi<{ import: ImportView }>(`/api/imports/${id}`, { refreshInterval: (d) => (!d || isImportActive(d.import.status) ? 1500 : 0) });
  const imp = data?.import;

  if (error && !imp) {
    return (
      <>
        <Link href="/clients/import" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />Import clients</Link>
        <Card><ErrorState title={error.status === 404 ? "We couldn't find this import" : "We couldn't load this import"} onRetry={error.status === 404 ? undefined : () => void mutate()} detail={error.code} /></Card>
      </>
    );
  }

  const active = !!imp && isImportActive(imp.status);
  const c = imp?.counts;
  const skipped = c ? c.invalid + c.duplicate + c.existing + c.skippedPlanLimit + c.failedToCreate : 0;

  const download = async () => {
    setBusy("dl");
    try {
      const { blob, truncated } = await apiDownload(`/api/imports/${id}/failed-rows`, { org: activeOrgId });
      saveFile(blob, "import-skipped-rows.csv");
      if (truncated) toast({ tone: "info", title: "Only the first 1,000 skipped rows are kept", description: "Fix those and re-upload; any others will show up again." });
    } catch (e) { toast({ tone: "error", title: "Couldn't download", description: errorMessage(e) }); } finally { setBusy(null); }
  };
  const resume = async () => {
    setBusy("resume");
    try { await call(`/api/imports/${id}/resume`, { method: "POST" }); await mutate(); toast({ tone: "success", title: "Import resumed" }); }
    catch (e) { toast({ tone: "error", title: "Couldn't resume", description: errorMessage(e) }); } finally { setBusy(null); }
  };

  return (
    <>
      <Link href="/clients/import" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />Import clients</Link>
      <div className="mb-6">
        {!imp ? <Skeleton className="h-8 w-72" /> : (
          <>
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">{imp.fileName}<ImportStatusBadge status={imp.status} /></h1>
            <p className="mt-1 text-sm text-muted">Started {formatDateTime(imp.createdAt)}{imp.completedAt ? ` · finished ${formatDateTime(imp.completedAt)}` : ""}</p>
          </>
        )}
      </div>

      {imp && !active && imp.status !== "failed" && (
        <Alert tone={skipped ? "warning" : "success"} className="mb-6" title={`${formatNumber(c!.imported)} client${c!.imported === 1 ? "" : "s"} imported${skipped ? `, ${formatNumber(skipped)} row${skipped === 1 ? "" : "s"} skipped` : ""}`}>
          {skipped ? "Download the skipped rows to see exactly why, fix them and import again." : "Everything in your file was imported."}
        </Alert>
      )}
      {imp?.status === "failed" && (
        <Alert tone="danger" className="mb-6" title="Nothing was imported">
          {imp.errorCode === "SUBSCRIPTION_INACTIVE" ? "Your subscription became inactive during the import." : imp.errorCode === "FORBIDDEN" ? "You no longer have permission to import clients." : "No rows could be added. Download the skipped rows to see why."}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Progress" description={active ? "Adding clients in the background. You can leave this page." : undefined} />
          <CardBody>
            {!imp ? <Skeleton className="h-24" /> : (
              <>
                <ProgressLine imp={imp} />
                <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {([["Imported", c!.imported, "text-success-strong"], ["Invalid rows", c!.invalid, ""], ["Repeated in file", c!.duplicate, ""], ["Already clients", c!.existing, ""], ["Over plan limit", c!.skippedPlanLimit, ""], ["Failed to add", c!.failedToCreate, ""]] as const).map(([k, v, cl]) => (
                    <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className={`tabular mt-0.5 text-lg font-semibold ${v > 0 ? cl : ""}`}>{formatNumber(v)}</dd></div>
                  ))}
                </dl>
                {active && can("imports:run") && <p className="mt-5 border-t border-line pt-4 text-xs text-muted">Not moving? <button className="font-medium underline" onClick={resume} disabled={busy === "resume"}>Resume this import</button></p>}
              </>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Next steps" />
          <CardBody className="space-y-3">
            {imp && imp.failedRowsCount > 0 && <Button variant="secondary" className="w-full" onClick={download} loading={busy === "dl"}><Download className="size-4" aria-hidden />Download skipped rows ({formatNumber(imp.failedRowsCount)})</Button>}
            <ButtonLink href="/clients" variant="primary" className="w-full"><Users className="size-4" aria-hidden />View clients</ButtonLink>
            {imp?.verify?.jobId && <ButtonLink href={`/bulk-checks/${imp.verify.jobId}`} variant="secondary" className="w-full"><ListChecks className="size-4" aria-hidden />View GST checks</ButtonLink>}
            {imp && !imp.verify?.requested && !active && c!.imported > 0 && <ButtonLink href="/bulk-checks" variant="secondary" className="w-full"><ListChecks className="size-4" aria-hidden />Run GST checks</ButtonLink>}
          </CardBody>
        </Card>
      </div>

      {imp?.verify?.requested && (
        <Card className="mt-6">
          <CardHeader title="GST verification" />
          <CardBody>
            {imp.verify.jobId ? <p className="text-sm">Checks for the imported clients are running. <Link className="font-medium underline underline-offset-2" href={`/bulk-checks/${imp.verify.jobId}`}>Follow their progress</Link>.</p>
              : imp.verify.errorCode ? <Alert tone="warning">{verifyErrorText(imp.verify.errorCode)} <Link className="font-medium underline" href="/bulk-checks">Open Bulk checks</Link></Alert>
              : <p className="text-sm text-muted">Verification starts automatically when the import finishes.</p>}
          </CardBody>
        </Card>
      )}
    </>
  );
}
