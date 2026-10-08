import Link from "next/link";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "./feedback";

/**
 * Surface. On phones (< sm) a page-level Card reaches the viewport edges (no side borders/radius) so content gets the full width;
 * the page's 16px padding is cancelled with a negative margin and re-created INSIDE the card by its own padding.
 * Pass `inset` for cards nested inside another padded container (they keep side margins and rounded corners).
 */
export function Card({ className, inset, ...p }: HTMLAttributes<HTMLDivElement> & { inset?: boolean }) {
  return (
    <div
      className={cn("rounded-[var(--radius-card)] border border-line bg-surface shadow-card", !inset && "max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 max-sm:shadow-none", className)}
      {...p}
    />
  );
}

// Card padding scale: 16px (phone) → 20px (tablet) → 24px (desktop).
export function CardHeader({ title, description, action, className }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-4 sm:gap-4 sm:px-5 sm:pt-5 lg:px-6 lg:pt-6", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export const CardBody = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn("p-4 sm:p-5 lg:p-6", className)} {...p} />;

export function StatCard({
  label, value, hint, icon, tone = "neutral", loading, href,
}: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue"; loading?: boolean; href?: string }) {
  const chip = { neutral: "bg-surface-muted text-muted", green: "bg-success-soft text-success-strong", amber: "bg-warning-soft text-warning-strong", red: "bg-danger-soft text-danger-strong", blue: "bg-info-soft text-info-strong" }[tone];
  const inner = (
    <Card inset className={cn("h-full p-3.5 transition-colors sm:p-5", href && "hover:border-line-strong")}>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-[13px] font-medium leading-tight text-muted sm:truncate">{label}</p>
        {icon && <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg sm:size-8 [&>svg]:size-4", chip)}>{icon}</span>}
      </div>
      {loading ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="tabular mt-2 text-2xl font-semibold leading-none tracking-tight sm:text-[28px]">{value}</p>}
      {loading ? <Skeleton className="mt-3 h-3.5 w-24 sm:w-32" /> : hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </Card>
  );
  return href ? <Link href={href} className="block h-full rounded-[var(--radius-card)]">{inner}</Link> : inner;
}
