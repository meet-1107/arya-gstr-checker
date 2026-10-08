"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Download, FileSpreadsheet, ShieldCheck, UploadCloud, X } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, saveFile } from "@/lib/client/api";
import { formatNumber } from "@/lib/client/format";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import { FIELD_LABELS, inspectCsv, reasonText, sampleCsv, validateCsvFile, type CsvInspection } from "@/lib/client/import-wizard";
import type { ImportPreview, ImportView } from "@/lib/client/types";
import type { ColumnMapping } from "@/lib/csv";
import { cn } from "@/lib/cn";
import { MAX_CSV_BYTES } from "@/lib/csv";

const STEPS = ["Upload", "Map columns", "Review", "Confirm"];
type MapState = Record<keyof ColumnMapping, number | "">;
type Row = ImportPreview["samples"]["valid"][number];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-8 flex items-center gap-2" aria-label="Import progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex flex-1 items-center gap-2" aria-current={i === step ? "step" : undefined}>
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", i < step ? "bg-success-solid text-success-solid-foreground" : i === step ? "bg-primary text-primary-foreground" : "bg-surface-hover text-muted")}>{i < step ? <Check className="size-3.5" aria-label="Completed" /> : i + 1}</span>
          <span className={cn("hidden text-xs font-medium sm:block", i === step ? "text-foreground" : "text-muted")}>{s}</span>
          {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

const colLabel = (i: number, header: string[], hasHeader: boolean) => `Column ${String.fromCharCode(65 + (i % 26))}${hasHeader && header[i]?.trim() ? ` — ${header[i].trim().slice(0, 28)}` : ""}`;

export function ImportWizard() {
  const router = useRouter();
  const { activeOrgId } = useSession();
  const call = useApiCall();
  const invalidate = useInvalidate();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState(0);
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [insp, setInsp] = useState<CsvInspection | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [map, setMap] = useState<MapState>({ gstin: "", name: "", email: "", phone: "" });
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [partialClients, setPartialClients] = useState(false);
  const [verify, setVerify] = useState(false);
  const [includeReturns, setIncludeReturns] = useState(true);
  const [partialVerify, setPartialVerify] = useState(false);
  const [attempt, setAttempt] = useState("");

  const reset = () => { setFile(null); setInsp(null); setPreview(null); setErr(null); setStep(0); setPartialClients(false); setVerify(false); };

  const onFile = async (f: File | undefined | null) => {
    if (!f) return;
    setErr(null);
    const bad = validateCsvFile(f);
    if (bad) return setErr(bad);
    let text: string;
    try { text = await f.text(); } catch { return setErr("We couldn't read that file."); }
    const i = inspectCsv(text);
    if (!i) return setErr("That file has no rows.");
    if (i.tooManyRows) return setErr("That file has more than 20,000 rows. Split it into smaller files.");
    if (i.rowCount <= 0) return setErr("That file has a header but no data rows.");
    setFile({ name: f.name, size: f.size, text }); setInsp(i); setHasHeader(i.hasHeader); setPreview(null); setAttempt(`ui-import-${crypto.randomUUID()}`);
    setMap({ gstin: i.mapping.gstin ?? "", name: i.mapping.name ?? "", email: i.mapping.email ?? "", phone: i.mapping.phone ?? "" });
    setStep(1);
  };

  const mapping = () => ({ gstin: map.gstin as number, ...(map.name !== "" ? { name: map.name } : {}), ...(map.email !== "" ? { email: map.email } : {}), ...(map.phone !== "" ? { phone: map.phone } : {}) });

  const toReview = async () => {
    if (!file) return;
    if (map.gstin === "") return setErr("Choose which column contains the GSTIN.");
    if (map.name === "") return setErr("Choose which column contains the client name — rows without a name can't be imported.");
    setErr(null); setBusy(true);
    try {
      const r = await call<{ preview: ImportPreview }>("/api/imports/preview", { method: "POST", body: { csv: file.text, fileName: file.name, hasHeader, mapping: mapping() } });
      setPreview(r.preview); setPartialClients(false); setStep(2);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  const start = async () => {
    if (!file || !preview) return;
    setBusy(true); setErr(null);
    const body = { csv: file.text, fileName: file.name, hasHeader, mapping: mapping(), allowPartialClients: partialClients, ...(verify ? { verify: { includeReturns, allowPartial: partialVerify } } : {}) };
    try {
      // Same key for the same file + options: a double-click, timeout-and-retry or flaky network can never import twice.
      const r = await api<{ import: ImportView; replay: boolean }>("/api/imports", { method: "POST", org: activeOrgId, body, headers: { "Idempotency-Key": `${attempt}-${partialClients}-${verify}-${includeReturns}-${partialVerify}` } });
      await invalidate("/api/imports");
      toast({ tone: "success", title: r.replay ? "This import is already running" : "Import started", description: `${formatNumber(r.import.toCreate)} client${r.import.toCreate === 1 ? "" : "s"} queued.` });
      router.push(`/clients/import/${r.import.id}`);
    } catch (e) { setErr(errorMessage(e)); setBusy(false); }
  };

  const p = preview;
  const canContinue = !!p && p.counts.valid > 0 && !p.readOnly && p.capacity.willImport > 0 && (p.capacity.fits || partialClients);

  return (
    <div>
      <Stepper step={step} />
      {err && <Alert tone="danger" className="mb-6" title={step === 0 ? "That file can't be used" : "Something needs attention"}>{err}</Alert>}

      {step === 0 && (
        <Card>
          <CardHeader title="Upload your client list" description="A CSV with a column for the GSTIN and one for the client name. Email and phone are optional." />
          <CardBody>
            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void onFile(e.dataTransfer.files[0]); }}
              className={cn("flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", drag ? "border-primary bg-surface-muted" : "border-line-strong bg-surface-muted hover:border-muted")}
            >
              <input ref={inputRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              <span className="flex size-12 items-center justify-center rounded-xl bg-surface text-muted shadow-card"><UploadCloud className="size-6" aria-hidden /></span>
              <span className="mt-4 text-[15px] font-semibold">Drag and drop a CSV here</span>
              <span className="mt-1 text-sm text-muted">or <span className="font-medium text-foreground underline underline-offset-2">choose a file</span> · up to {MAX_CSV_BYTES / 1024 / 1024} MB and 20,000 rows</span>
            </label>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
              <p className="text-muted">Example columns: <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs">client_name, gstin, email, phone</code></p>
              <Button size="sm" variant="secondary" onClick={() => saveFile(sampleCsv(), "sample-clients.csv")}><Download className="size-3.5" aria-hidden />Download sample CSV</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 1 && file && insp && (
        <Card>
          <CardHeader title="Match your columns" description={<><FileSpreadsheet className="mr-1.5 inline size-3.5 align-text-bottom" aria-hidden />{file.name} · {formatNumber(insp.rowCount)} row{insp.rowCount === 1 ? "" : "s"}</>} action={<Button size="sm" variant="ghost" onClick={reset}><X className="size-3.5" aria-hidden />Change file</Button>} />
          <CardBody className="space-y-6">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm"><input type="checkbox" className="size-4 rounded accent-primary" checked={hasHeader} onChange={(e) => { setHasHeader(e.target.checked); setErr(null); }} />The first row contains column names</label>
            <div className="grid gap-4 sm:grid-cols-2">
              {(["gstin", "name", "email", "phone"] as const).map((k) => (
                <div key={k}>
                  <label htmlFor={`map-${k}`} className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium"><span>{FIELD_LABELS[k]}</span><span className="text-xs font-normal text-muted">{k === "gstin" || k === "name" ? "Required" : "Optional"}</span></label>
                  <Select id={`map-${k}`} value={map[k]} onChange={(e) => setMap((m) => ({ ...m, [k]: e.target.value === "" ? "" : Number(e.target.value) }))}>
                    <option value="">{k === "gstin" || k === "name" ? "Choose a column…" : "Not in my file"}</option>
                    {Array.from({ length: insp.columns }, (_, i) => <option key={i} value={i}>{colLabel(i, insp.header, hasHeader)}</option>)}
                  </Select>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">First rows of your file</p>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm"><caption className="sr-only">Preview of the first rows</caption>
                  <thead><tr className="border-b border-line bg-surface-muted text-left text-xs text-muted">{Array.from({ length: insp.columns }, (_, i) => <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{colLabel(i, insp.header, hasHeader)}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">{insp.sample.map((r, ri) => <tr key={ri}>{Array.from({ length: insp.columns }, (_, i) => <td key={i} className="max-w-48 truncate whitespace-nowrap px-3 py-2">{r[i]}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
            <div className="flex gap-3 border-t border-line pt-5"><Button variant="secondary" onClick={reset} disabled={busy}><ArrowLeft className="size-4" aria-hidden />Back</Button><Button variant="primary" onClick={toReview} loading={busy}>Check my file<ArrowRight className="size-4" aria-hidden /></Button></div>
          </CardBody>
        </Card>
      )}

      {step === 2 && (!p ? <Skeleton className="h-64 w-full !rounded-xl" /> : (
        <Card>
          <CardHeader title="Review before importing" description="We checked every row. Nothing has been imported yet." />
          <CardBody className="space-y-6">
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[["Ready to import", p.counts.valid, "text-success-strong"], ["Invalid", p.counts.invalid, p.counts.invalid ? "text-danger-strong" : ""], ["Repeated in file", p.counts.duplicate, p.counts.duplicate ? "text-warning-strong" : ""], ["Already clients", p.counts.existing, p.counts.existing ? "text-warning-strong" : ""]].map(([k, v, c]) => (
                <div key={k as string} className="rounded-xl border border-line p-4"><dt className="text-xs text-muted">{k}</dt><dd className={cn("tabular mt-1 text-2xl font-semibold", c as string)}>{formatNumber(v as number)}</dd></div>
              ))}
            </dl>

            {p.readOnly && <Alert tone="danger" title="This workspace is read-only">Choose a plan before importing clients.</Alert>}
            {p.counts.valid === 0 && <Alert tone="danger" title="No rows can be imported">Check the column mapping, or fix the reasons listed below and upload again.</Alert>}
            {p.counts.valid > 0 && p.capacity.willImport === 0 && (
              <Alert tone="warning" title="Your plan's client limit is full">You already have {formatNumber(p.capacity.used)} of {formatNumber(p.capacity.limit)} clients, so nothing from this file can be added. Upgrade your plan or delete clients you no longer need.</Alert>
            )}
            {p.counts.valid > 0 && p.capacity.willImport > 0 && !p.capacity.fits && (
              <Alert tone="warning" title={`Your plan has room for ${formatNumber(p.capacity.remaining)} more client${p.capacity.remaining === 1 ? "" : "s"}`}>
                This file has {formatNumber(p.counts.valid)} importable rows. Upgrade your plan, or import only the first {formatNumber(p.capacity.willImport)} and skip the rest.
                <label className="mt-2 flex cursor-pointer items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={partialClients} onChange={(e) => setPartialClients(e.target.checked)} />Import the first {formatNumber(p.capacity.willImport)} and skip {formatNumber(p.capacity.willSkip)}</label>
              </Alert>
            )}

            <Tabs defaultValue={p.counts.invalid ? "invalid" : "valid"}>
              <TabsList aria-label="Row groups">
                <TabsTrigger value="valid">Ready ({formatNumber(p.counts.valid)})</TabsTrigger>
                <TabsTrigger value="invalid">Invalid ({formatNumber(p.counts.invalid)})</TabsTrigger>
                <TabsTrigger value="duplicate">Repeated ({formatNumber(p.counts.duplicate)})</TabsTrigger>
                <TabsTrigger value="existing">Already clients ({formatNumber(p.counts.existing)})</TabsTrigger>
              </TabsList>
              {(["valid", "invalid", "duplicate", "existing"] as const).map((g) => {
                const rows = p.samples[g];
                const cols: Column<Row>[] = [
                  { key: "line", header: "Row", className: "w-16", cell: (r) => <span className="tabular text-muted">{r.line}</span> },
                  { key: "name", header: "Client", primary: true, cell: (r) => r.name || <span className="text-subtle">—</span> },
                  { key: "gstin", header: "GSTIN", cell: (r) => <span className="font-mono text-[13px]">{r.gstin || "—"}</span> },
                  g === "valid" ? { key: "email", header: "Email", hideOnMobile: true, cell: (r) => r.email || <span className="text-subtle">—</span> } : { key: "why", header: "Reason", cell: (r) => <span className="text-danger-strong">{reasonText(r.reason)}</span> },
                ];
                return (
                  <TabsContent key={g} value={g}>
                    {rows.length === 0 ? <p className="py-8 text-center text-sm text-muted">Nothing here.</p> : (
                      <div className="overflow-hidden rounded-xl border border-line">
                        <DataTable caption={`${g} rows`} columns={cols} rows={rows} rowKey={(r) => String(r.line)} />
                        {p.counts[g] > rows.length && <p className="border-t border-line bg-surface-muted px-4 py-2.5 text-xs text-muted">Showing the first {rows.length} of {formatNumber(p.counts[g])}.{g !== "valid" && " After importing you can download every skipped row as a CSV."}</p>}
                      </div>
                    )}
                  </TabsContent>
                );
              })}
            </Tabs>
            <div className="flex gap-3 border-t border-line pt-5"><Button variant="secondary" onClick={() => { setStep(1); setErr(null); }}><ArrowLeft className="size-4" aria-hidden />Back</Button><Button variant="primary" disabled={!canContinue} onClick={() => setStep(3)}>Continue<ArrowRight className="size-4" aria-hidden /></Button></div>
          </CardBody>
        </Card>
      ))}

      {step === 3 && p && (
        <Card>
          <CardHeader title="Ready to import" description="Clients are added in the background — you can leave this page." />
          <CardBody className="space-y-6">
            <dl className="divide-y divide-line rounded-xl border border-line text-sm">
              <div className="flex justify-between px-4 py-3"><dt className="text-muted">File</dt><dd className="max-w-60 truncate font-medium">{file?.name}</dd></div>
              <div className="flex justify-between px-4 py-3"><dt className="text-muted">Clients to add</dt><dd className="tabular font-semibold">{formatNumber(p.capacity.willImport)}</dd></div>
              <div className="flex justify-between px-4 py-3"><dt className="text-muted">Rows skipped</dt><dd className="tabular font-medium">{formatNumber(p.counts.invalid + p.counts.duplicate + p.counts.existing + p.capacity.willSkip)}</dd></div>
              <div className="flex justify-between px-4 py-3"><dt className="text-muted">Client slots left after</dt><dd className="tabular font-medium">{p.capacity.remaining === null ? "Custom" : formatNumber(Math.max(0, p.capacity.remaining - p.capacity.willImport))}</dd></div>
            </dl>

            <div className={cn("rounded-xl border p-4", verify ? "border-primary ring-1 ring-primary" : "border-line")}>
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 rounded accent-primary" checked={verify} disabled={!p.verify.bulkAllowed || p.verify.tooManyForOneRun} onChange={(e) => setVerify(e.target.checked)} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 font-medium"><ShieldCheck className="size-4 text-success-strong" aria-hidden />Check these GSTINs right after importing<Badge tone="neutral">Optional</Badge></span>
                  <span className="mt-0.5 block text-muted">Retrieves GST status{includeReturns ? " and GSTR-1 / GSTR-3B history" : ""} for the new clients. You can also do this later from Bulk checks.</span>
                </span>
              </label>
              {!p.verify.bulkAllowed && <p className="mt-3 text-xs text-warning-strong">Bulk checks aren&apos;t included in your plan — upgrade to verify many clients at once.</p>}
              {p.verify.tooManyForOneRun && <p className="mt-3 text-xs text-warning-strong">Too many clients for one run — use Bulk checks → “Never checked” after importing.</p>}
              {verify && (
                <div className="mt-4 space-y-3 border-t border-line pt-4 text-sm">
                  <dl className="grid gap-2 sm:grid-cols-3">
                    <div><dt className="text-xs text-muted">Will use</dt><dd className="tabular font-semibold">{formatNumber(p.verify.checks)} checks</dd></div>
                    <div><dt className="text-xs text-muted">Remaining after</dt><dd className="tabular font-semibold">{p.verify.afterRemaining === null ? "Custom" : formatNumber(p.verify.afterRemaining)}</dd></div>
                    <div><dt className="text-xs text-muted">Estimated time</dt><dd className="font-semibold">{(() => { const s = includeReturns ? p.verify.seconds.full : p.verify.seconds.statusOnly; return s < 90 ? "about a minute" : `about ${Math.ceil(s / 60)} min`; })()}</dd></div>
                  </dl>
                  <label className="flex cursor-pointer items-center gap-2.5"><input type="checkbox" className="size-4 rounded accent-primary" checked={includeReturns} onChange={(e) => setIncludeReturns(e.target.checked)} />Include GSTR-1 / GSTR-3B history (slower)</label>
                  {!p.verify.sufficient && <Alert tone="warning" title="Not enough checks remaining for all of them">Only {formatNumber(p.verify.remaining)} are left this month.<label className="mt-2 flex cursor-pointer items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={partialVerify} onChange={(e) => setPartialVerify(e.target.checked)} />Check as many as remaining</label></Alert>}
                </div>
              )}
            </div>

            <div className="flex gap-3 border-t border-line pt-5">
              <Button variant="secondary" onClick={() => setStep(2)} disabled={busy}><ArrowLeft className="size-4" aria-hidden />Back</Button>
              <Button variant="brand" onClick={start} loading={busy} disabled={verify && !p.verify.sufficient && !partialVerify}>Import {formatNumber(p.capacity.willImport)} client{p.capacity.willImport === 1 ? "" : "s"}</Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
