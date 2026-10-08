import { useId, type ComponentProps, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-lg border bg-surface px-3 text-sm text-foreground placeholder:text-subtle shadow-card transition-colors " +
  "border-line-strong hover:border-muted focus-visible:border-info disabled:bg-surface-muted disabled:text-muted";

/** Label + control + hint/error wired with aria attributes. Pass a render-prop to receive the ids. */
export function Field({
  label, hint, error, optional, children,
}: { label: string; hint?: string; error?: string | null; optional?: boolean; children: (p: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode }) {
  const id = useId();
  const desc = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline justify-between text-[13px] font-medium text-foreground">
        <span>{label}</span>
        {optional && <span className="text-xs font-normal text-muted">Optional</span>}
      </label>
      {children({ id, "aria-describedby": desc, "aria-invalid": error ? true : undefined })}
      {error ? <p id={`${id}-err`} role="alert" className="text-xs text-danger-strong">{error}</p>
        : hint ? <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Input({ className, ...p }: ComponentProps<"input">) {
  return <input className={cn(control, "h-10", "aria-[invalid=true]:border-danger", className)} {...p} />;
}
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-20 py-2", className)} {...p} />;
}
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(control, "h-10 appearance-none pr-9", className)} {...p}>{children}</select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}
