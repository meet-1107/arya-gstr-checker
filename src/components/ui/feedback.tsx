import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn("size-4 animate-spin", className)} aria-hidden />;

export const Skeleton = ({ className }: { className?: string }) => <div aria-hidden className={cn("skeleton", className)} />;

const TONE = {
  info: { box: "border-info/25 bg-info-soft text-info-strong", Icon: Info },
  success: { box: "border-success/25 bg-success-soft text-success-strong", Icon: CheckCircle2 },
  warning: { box: "border-warning/30 bg-warning-soft text-warning-strong", Icon: AlertTriangle },
  danger: { box: "border-danger/25 bg-danger-soft text-danger-strong", Icon: XCircle },
} as const;

export function Alert({ tone = "info", title, children, action, className }: { tone?: keyof typeof TONE; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const { box, Icon } = TONE[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} /* only real errors interrupt screen readers; notices are polite */ className={cn("flex gap-3 rounded-lg border p-3.5 text-sm", box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && "mt-0.5", "text-[13px] leading-relaxed")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-surface-muted text-muted [&>svg]:size-5">{icon}</div>}
      <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "We couldn't load this", description, onRetry, detail }: { title?: string; description?: string; onRetry?: () => void; detail?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-danger-soft text-danger-strong"><AlertTriangle className="size-5" aria-hidden /></div>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted">{description ?? "Something went wrong while loading your data. Your information is safe."}</p>
      {detail && <p className="mt-1 text-xs text-subtle">{detail}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-5 inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium shadow-card hover:bg-surface-hover">Try again</button>
      )}
    </div>
  );
}

/** Percentage bar with accessible text alternative (never colour-only). */
export function ProgressBar({ value, max = 100, tone = "brand", label, className, size = "md" }: { value: number; max?: number; tone?: "brand" | "amber" | "red" | "blue"; label: string; className?: string; size?: "sm" | "md" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill = { brand: "bg-success", amber: "bg-warning", red: "bg-danger", blue: "bg-info" }[tone];
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value)} className={cn("w-full overflow-hidden rounded-full bg-surface-muted", size === "sm" ? "h-1.5" : "h-2", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}
