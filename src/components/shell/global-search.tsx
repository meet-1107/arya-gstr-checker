"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { useApi, toQuery } from "@/lib/client/hooks";
import type { GstinList } from "@/lib/client/types";
import { StatusBadge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/feedback";

/** Searches the organization's GSTINs by GSTIN prefix or client-name prefix (GET /api/gstins?q=). Press "/" to focus. */
export function GlobalSearch() {
  const router = useRouter();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 220); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { data, isLoading } = useApi<GstinList>(term.length >= 2 ? `/api/gstins${toQuery({ q: term, limit: 6 })}` : null);
  const items = term.length >= 2 ? data?.items ?? [] : [];
  const show = open && term.length >= 2;

  const go = (gstin: string) => { setOpen(false); setQ(""); router.push(`/gstins/${gstin}`); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && show && items[active]) { e.preventDefault(); go(items[active].gstin); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  };

  return (
    <div className="relative w-full max-w-md">
      <label htmlFor={`${id}-in`} className="sr-only">Search clients and GSTINs</label>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={inputRef} id={`${id}-in`} role="combobox" aria-expanded={show} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={show && items[active] ? `${id}-opt-${active}` : undefined}
        value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown}
        placeholder="Search…" autoComplete="off" spellCheck={false}
        className="h-9 w-full rounded-lg border border-line bg-surface-muted pl-9 pr-9 text-sm placeholder:text-subtle hover:border-line-strong focus-visible:border-info focus-visible:bg-surface"
      />
      <kbd aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line-strong bg-surface px-1.5 text-[11px] text-muted sm:block">/</kbd>
      {show && (
        <ul id={`${id}-list`} role="listbox" aria-label="Search results" className="animate-pop absolute left-0 right-0 top-11 z-50 max-h-80 overflow-auto rounded-xl border border-line bg-surface p-1.5 shadow-pop">
          {isLoading && <li className="flex items-center gap-2 px-3 py-3 text-sm text-muted"><Spinner />Searching…</li>}
          {!isLoading && items.length === 0 && <li className="px-3 py-3 text-sm text-muted">No clients or GSTINs match “{term}”.</li>}
          {items.map((r, i) => (
            <li key={r.gstin} id={`${id}-opt-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(r.gstin); }}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 ${i === active ? "bg-surface-muted" : ""}`}>
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{r.clientName ?? "Client"}</span><span className="block font-mono text-xs text-muted">{r.gstin}</span></span>
              <StatusBadge status={r.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
