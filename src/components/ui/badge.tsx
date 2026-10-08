import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, HelpCircle, MinusCircle, PauseCircle, ShieldAlert, ShieldCheck, ShieldQuestion, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { FilingState, Indicator } from "@/lib/compliance";

type Tone = "neutral" | "green" | "amber" | "red" | "blue" | "ink";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-muted text-foreground",
  green: "bg-success-soft text-success-strong",
  amber: "bg-warning-soft text-warning-strong",
  red: "bg-danger-soft text-danger-strong",
  blue: "bg-info-soft text-info-strong",
  ink: "bg-primary text-primary-foreground",
};

export function Badge({ tone = "neutral", icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium [&>svg]:size-3.5", TONES[tone], className)}>
      {icon}{children}
    </span>
  );
}

// Status is ALWAYS communicated with an icon + text label, never colour alone.
const GSTIN: Record<string, { tone: Tone; Icon: typeof CheckCircle2; label: string }> = {
  Active: { tone: "green", Icon: CheckCircle2, label: "Active" },
  Suspended: { tone: "amber", Icon: PauseCircle, label: "Suspended" },
  Cancelled: { tone: "red", Icon: XCircle, label: "Cancelled" },
  Inactive: { tone: "neutral", Icon: MinusCircle, label: "Inactive" },
  Unknown: { tone: "neutral", Icon: HelpCircle, label: "Not checked" },
  "API Error": { tone: "red", Icon: AlertTriangle, label: "API error" },
};
export function StatusBadge({ status }: { status: string }) {
  const s = GSTIN[status] ?? GSTIN.Unknown;
  return <Badge tone={s.tone} icon={<s.Icon aria-hidden />}>{s.label}</Badge>;
}

const IND: Record<Indicator, { tone: Tone; Icon: typeof ShieldCheck; label: string }> = {
  Good: { tone: "green", Icon: ShieldCheck, label: "Good" },
  "Needs Attention": { tone: "amber", Icon: TriangleAlert, label: "Needs attention" },
  "High Attention": { tone: "red", Icon: ShieldAlert, label: "High attention" },
  "Data Unavailable": { tone: "neutral", Icon: ShieldQuestion, label: "Data unavailable" },
};
export function IndicatorBadge({ value }: { value?: Indicator }) {
  const s = IND[value ?? "Data Unavailable"];
  return <Badge tone={s.tone} icon={<s.Icon aria-hidden />}>{s.label}</Badge>;
}

const FILING: Record<FilingState, { tone: Tone; Icon: typeof CheckCircle2; label: string }> = {
  FILED_ON_TIME: { tone: "green", Icon: CheckCircle2, label: "Filed" },
  FILED_LATE: { tone: "amber", Icon: Clock, label: "Filed late" },
  NOT_FILED: { tone: "red", Icon: XCircle, label: "Missing" },
  PENDING: { tone: "blue", Icon: CircleDashed, label: "Due" },
  UNKNOWN: { tone: "neutral", Icon: HelpCircle, label: "Unknown" },
};
export function FilingBadge({ state }: { state: FilingState }) {
  const s = FILING[state] ?? FILING.UNKNOWN;
  return <Badge tone={s.tone} icon={<s.Icon aria-hidden />}>{s.label}</Badge>;
}
