import { CheckCircle2, CircleDashed, Loader2, MinusCircle, TriangleAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobView } from "@/lib/client/types";

export const isActive = (s: string) => s === "queued" || s === "running";

export function JobStatusBadge({ status }: { status: JobView["status"] | string }) {
  switch (status) {
    case "queued": return <Badge tone="neutral" icon={<CircleDashed aria-hidden />}>Queued</Badge>;
    case "running": return <Badge tone="blue" icon={<Loader2 className="animate-spin" aria-hidden />}>Running</Badge>;
    case "completed": return <Badge tone="green" icon={<CheckCircle2 aria-hidden />}>Completed</Badge>;
    case "completed_with_errors": return <Badge tone="amber" icon={<TriangleAlert aria-hidden />}>Completed with errors</Badge>;
    case "failed": return <Badge tone="red" icon={<XCircle aria-hidden />}>Failed</Badge>;
    case "cancelled": return <Badge tone="neutral" icon={<MinusCircle aria-hidden />}>Cancelled</Badge>;
    default: return <Badge>{status}</Badge>;
  }
}

export function ItemStatusBadge({ status }: { status: string }) {
  const m: Record<string, { tone: "neutral" | "blue" | "green" | "amber" | "red"; label: string }> = {
    queued: { tone: "neutral", label: "Queued" }, processing: { tone: "blue", label: "Checking" }, succeeded: { tone: "green", label: "Checked" },
    cached: { tone: "green", label: "From cache" }, failed: { tone: "red", label: "Failed" }, cancelled: { tone: "neutral", label: "Cancelled" },
  };
  const s = m[status] ?? { tone: "neutral" as const, label: status };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const ERRORS: Record<string, string> = {
  GST_PROVIDER_TIMEOUT: "The GST provider timed out", GST_PROVIDER_UNAVAILABLE: "The GST provider is temporarily unavailable",
  GST_PROVIDER_RATE_LIMITED: "The GST provider asked us to slow down", GST_PROVIDER_BAD_RESPONSE: "Unexpected response from the GST provider",
  GST_PROVIDER_AUTH: "GST provider authentication problem", GST_PROVIDER_NOT_CONFIGURED: "GST provider isn't configured",
  QUOTA_EXHAUSTED: "Monthly GST check allowance used up", SUBSCRIPTION_INACTIVE: "Subscription is not active",
  FORBIDDEN: "The requester no longer has permission", CLIENT_NOT_FOUND: "Client was deleted", WORKER_TIMEOUT: "Processing was interrupted", INTERNAL_ERROR: "Something went wrong on our side",
};
export const friendlyError = (code?: string) => (code ? ERRORS[code] ?? "Check failed" : "");
