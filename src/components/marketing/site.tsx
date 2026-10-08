import Link from "next/link";
import { BRAND } from "@/config/brand";
import { ButtonLink } from "@/components/ui/button";
import { Logo } from "@/components/shell/logo";
import { ThemeToggle } from "@/components/theme";

export function SiteHeader() {
  const link = "text-sm text-muted hover:text-foreground";
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          <Link href="/#features" className={link}>Features</Link>
          <Link href="/#how-it-works" className={link}>How it works</Link>
          <Link href="/pricing" className={link}>Pricing</Link>
          <Link href="/#faq" className={link}>FAQ</Link>
        </nav>
        <div className="flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Link href="/login" className="hidden px-3 text-sm font-medium sm:block">Sign in</Link>
          <ButtonLink href="/register" size="sm">Start free</ButtonLink>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-12 md:flex-row md:items-start md:justify-between">
        <div className="max-w-xs"><Logo /><p className="mt-3 text-sm text-muted">{BRAND.tagline}</p></div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-16 gap-y-2 text-sm">
          <Link href="/#features" className="text-muted hover:text-foreground">Features</Link><Link href="/pricing" className="text-muted hover:text-foreground">Pricing</Link>
          <Link href="/#faq" className="text-muted hover:text-foreground">FAQ</Link><Link href="/#security" className="text-muted hover:text-foreground">Security</Link>
          <Link href="/login" className="text-muted hover:text-foreground">Sign in</Link><Link href="/register" className="text-muted hover:text-foreground">Create account</Link>
        </nav>
      </div>
      <div className="border-t border-line px-6 py-5 text-center text-xs text-subtle">
        © {new Date().getFullYear()} {BRAND.name}. {BRAND.name} is an independent product and is not affiliated with, or endorsed by, the GST Network or any government body.
      </div>
    </footer>
  );
}
