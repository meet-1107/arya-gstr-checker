import type { ReactNode } from "react";
import { Hammer } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "./page-header";

/** Honest placeholder for features whose backend does not exist yet. Nothing is faked. */
export function ComingNext({ title, description, icon, planned, children }: { title: string; description: string; icon: ReactNode; planned: string[]; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-3">{title}<Badge tone="neutral">Coming next</Badge></span>} description={description} />
      <Card>
        <EmptyState icon={icon} title={`${title} isn't available yet`} description="This part of the product is still being built. Everything else in your workspace works today." action={children} />
        <div className="border-t border-line px-6 py-5">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted"><Hammer className="size-3.5" aria-hidden />Planned</p>
          <ul className="mt-3 grid gap-2 text-sm text-foreground sm:grid-cols-2">{planned.map((p) => <li key={p} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-subtle" aria-hidden />{p}</li>)}</ul>
        </div>
      </Card>
    </>
  );
}
