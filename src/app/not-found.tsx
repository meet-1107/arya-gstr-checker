import Link from "next/link";
import { SearchX } from "lucide-react";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-surface-muted text-muted" aria-hidden><SearchX className="size-6" /></span>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">We couldn&apos;t find that page</h1>
      <p className="mt-2 text-sm text-muted">The link may be old or mistyped.</p>
      <div className="mt-6 flex gap-2">
        <Link href="/dashboard" className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover">Go to dashboard</Link>
        <Link href="/" className="inline-flex h-10 items-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium shadow-card hover:bg-surface-hover">Home</Link>
      </div>
    </main>
  );
}
