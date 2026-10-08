"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ClientGstins } from "@/components/clients/client-gstins";
import { GstinView } from "@/components/gstin/gstin-view";
import { Card } from "@/components/ui/card";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { useApi } from "@/lib/client/hooks";
import type { Client } from "@/lib/client/types";

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, mutate } = useApi<{ client: Client }>(`/api/clients/${id}`);
  const [picked, setPicked] = useState<string | null>(null);
  if (error) return <><Link href="/clients" className="mb-4 inline-block text-sm text-muted hover:text-foreground">← Clients</Link><Card><ErrorState title={error.status === 404 ? "We couldn't find this client" : "We couldn't load this client"} description={error.status === 404 ? "It may have been deleted." : undefined} onRetry={error.status === 404 ? undefined : () => void mutate()} detail={error.code} /></Card></>;
  if (!data) return <div className="space-y-4" aria-busy="true"><Skeleton className="h-8 w-72" /><Skeleton className="h-4 w-48" /><Skeleton className="mt-6 h-64 !rounded-xl" /></div>;
  const c = data.client;
  const gstin = picked && (c.gstins ?? [c.gstin]).includes(picked) ? picked : c.gstin;
  return (
    <>
      <ClientGstins client={c} selected={gstin} onSelect={setPicked} />
      <GstinView key={gstin} gstin={gstin} backHref="/clients" backLabel="Clients" />
    </>
  );
}
