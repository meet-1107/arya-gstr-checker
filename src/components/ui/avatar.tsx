import { cn } from "@/lib/cn";
import { initials } from "@/lib/client/format";

const PALETTE = ["bg-success-soft text-success-strong", "bg-info-soft text-info-strong", "bg-warning-soft text-warning-strong", "bg-surface-hover text-foreground", "bg-danger-soft text-danger-strong"];

export function Avatar({ name, email, size = "md", className }: { name?: string; email?: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const key = (email ?? name ?? "?");
  const tone = PALETTE[[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold", tone, { sm: "size-7 text-[11px]", md: "size-8 text-xs", lg: "size-10 text-sm" }[size], className)}>
      {initials(name, email)}
    </span>
  );
}
