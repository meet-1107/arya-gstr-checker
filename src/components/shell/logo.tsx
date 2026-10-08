import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { BRAND } from "@/config/brand";
import { cn } from "@/lib/cn";

export function Logo({ href = "/", light, className }: { href?: string; light?: boolean; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5", className)} aria-label={`${BRAND.name} home`}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-success text-success-solid-foreground"><ShieldCheck className="size-[18px]" strokeWidth={2.4} aria-hidden /></span>
      <span className={cn("text-[15px] font-semibold tracking-tight", light ? "text-inverse-foreground" : "text-foreground")}>{BRAND.name}</span>
    </Link>
  );
}
