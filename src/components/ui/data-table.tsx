"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { Skeleton } from "./feedback";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Identity of the row. Table: the linked cell. Phone: the card title. */
  primary?: boolean;
  /** Phone only: shown as a badge next to the title (use for status columns). */
  badge?: boolean;
  /** Phone: omit from the card (secondary data). */
  hideOnMobile?: boolean;
  /** Tablet (md–lg): omit this lower-priority column so the table fits without scrolling. */
  tabletHidden?: boolean;
  className?: string;
  align?: "right";
}

const tabletCls = (c: { tabletHidden?: boolean }) => (c.tabletHidden ? "hidden lg:table-cell" : "");

/**
 * Responsive data table.
 *  • phone (< md): stacked cards — identity + status badge on top, key facts below, whole card tappable
 *  • tablet (md–lg): real table; low-priority columns are hidden, and anything still too wide scrolls INSIDE the table
 *    wrapper (never the page)
 *  • desktop (lg+): full table
 * Rows link through a real anchor in the primary cell, so keyboard and screen readers work.
 */
export function DataTable<T>({
  columns, rows, rowKey, href, loading, skeletonRows = 6, caption,
}: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; href?: (r: T) => string; loading?: boolean; skeletonRows?: number; caption: string }) {
  const router = useRouter();
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const badges = columns.filter((c) => c.badge && c !== primary);
  const facts = columns.filter((c) => c !== primary && !c.badge && !c.hideOnMobile && c.header);
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-muted">
              {columns.map((c) => <th key={c.key} scope="col" className={cn("whitespace-nowrap px-4 py-3 font-medium xl:px-5", c.align === "right" && "text-right", tabletCls(c), c.className)}>{c.header || <span className="sr-only">{c.key === "sel" ? "Select" : "Actions"}</span>}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <tr key={i}>{columns.map((c) => <td key={c.key} className={cn("px-4 py-3 xl:px-5", tabletCls(c))}><Skeleton className="h-4 w-full max-w-32" /></td>)}</tr>
                ))
              : rows.map((r) => (
                  <tr key={rowKey(r)} onClick={href ? () => router.push(href(r)) : undefined} className={cn(href && "cursor-pointer hover:bg-surface-hover")}>
                    {columns.map((c) => (
                      <td key={c.key} className={cn("px-4 py-3 align-middle xl:px-5", c.align === "right" && "text-right", tabletCls(c), c.className)}>
                        {href && c === primary ? <Link href={href(r)} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>{c.cell(r)}</Link> : c.cell(r)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-line md:hidden" aria-label={caption}>
        {loading
          ? Array.from({ length: Math.min(skeletonRows, 4) }, (_, i) => <li key={i} className="space-y-2 px-4 py-4"><Skeleton className="h-4 w-40" /><Skeleton className="h-3.5 w-56" /></li>)
          : rows.map((r) => (
              <li key={rowKey(r)} onClick={href ? () => router.push(href(r)) : undefined} className={cn("px-4 py-3.5", href && "cursor-pointer active:bg-surface-hover")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 font-medium">{href ? <Link href={href(r)} className="hover:underline" onClick={(e) => e.stopPropagation()}>{primary.cell(r)}</Link> : primary.cell(r)}</div>
                  <div className="flex shrink-0 items-center gap-2">
                    {badges.map((b) => <span key={b.key}>{b.cell(r)}</span>)}
                    {href && <ChevronRight className="size-4 text-subtle" aria-hidden />}
                  </div>
                </div>
                {facts.length > 0 && (
                  <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
                    {facts.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-[11px] uppercase tracking-wide text-muted">{c.header}</dt>
                        <dd className="mt-0.5 truncate text-sm">{c.cell(r)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
      </ul>
    </>
  );
}

/** Cursor pagination controls. The parent keeps a stack of cursors so "Previous" works with opaque cursors. */
export function CursorPager({ page, hasNext, hasPrev, onNext, onPrev, loading, label }: { page: number; hasNext: boolean; hasPrev: boolean; onNext: () => void; onPrev: () => void; loading?: boolean; label?: string }) {
  const btn = "inline-flex h-10 items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-card hover:bg-surface-hover disabled:opacity-40 sm:h-8 sm:px-2.5";
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-line px-4 py-3 xl:px-5">
      <p className="text-xs text-muted" aria-live="polite">{label ?? `Page ${page}`}</p>
      <div className="flex gap-2">
        <button onClick={onPrev} disabled={!hasPrev || loading} className={btn}><ChevronLeft className="size-4" aria-hidden />Previous</button>
        <button onClick={onNext} disabled={!hasNext || loading} className={btn}>Next<ChevronRight className="size-4" aria-hidden /></button>
      </div>
    </nav>
  );
}
