import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "brand" | "secondary" | "ghost" | "danger" | "inverse";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover shadow-card",
  brand: "bg-success-solid text-success-solid-foreground hover:bg-success-solid-hover shadow-card",
  secondary: "bg-surface text-foreground border border-line-strong hover:bg-surface-hover shadow-card",
  ghost: "text-foreground hover:bg-surface-hover",
  danger: "bg-danger-solid text-danger-solid-foreground hover:bg-danger-solid/90 shadow-card",
  /** On inverse surfaces (landing bands, sidebar) */
  inverse: "border border-inverse-border bg-inverse-hover text-inverse-foreground hover:bg-inverse-active",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
  lg: "h-11 px-6 text-[15px] gap-2",
};

export const buttonClass = (variant: ButtonVariant = "primary", size: ButtonSize = "md", extra?: string) =>
  cn(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
    VARIANT[variant], SIZE[size], extra,
  );

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }

export function Button({ variant, size, loading, className, children, disabled, type = "button", ...rest }: Props) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)} {...rest}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function ButtonLink({ variant, size, className, ...rest }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}
