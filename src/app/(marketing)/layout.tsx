import { SiteFooter, SiteHeader } from "@/components/marketing/site";

export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <SiteHeader />
      <main id="main" className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
