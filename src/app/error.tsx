"use client";
import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

/**
 * Last-resort boundary for an unexpected rendering error in any page. Without it production shows Next's bare "Application error" screen.
 * Shows no stack and no message from the error (it may contain internals); the digest is a server-log reference the user can quote to support.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("[ui] unexpected error", error.name, error.digest ?? ""); }, [error]);
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center outline-none">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-warning-soft text-warning-strong" aria-hidden><TriangleAlert className="size-6" /></span>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">Something went wrong on our side</h1>
      <p className="mt-2 text-sm text-muted">The page couldn&apos;t be shown. Your data hasn&apos;t been changed. Try again, or go back to the dashboard.</p>
      {error.digest && <p className="mt-3 text-xs text-muted">Reference: <span className="font-mono">{error.digest}</span></p>}
      <div className="mt-6 flex gap-2">
        <button type="button" onClick={reset} className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover">Try again</button>
        <Link href="/dashboard" className="inline-flex h-10 items-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium shadow-card hover:bg-surface-hover">Go to dashboard</Link>
      </div>
    </main>
  );
}
