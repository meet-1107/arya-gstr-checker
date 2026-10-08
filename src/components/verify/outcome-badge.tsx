import { AlertTriangle, CheckCircle2, Clock, HelpCircle, MinusCircle, PauseCircle, ShieldQuestion, WifiOff, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EXPLANATIONS, type VerificationOutcome } from "@/lib/verification";

const BADGE_TONE = { success: "green", warning: "amber", danger: "red", info: "blue", neutral: "neutral" } as const;
const ICON: Record<VerificationOutcome, typeof CheckCircle2> = {
  ACTIVE: CheckCircle2, SUSPENDED: PauseCircle, CANCELLED: XCircle, INACTIVE: MinusCircle, UNKNOWN: HelpCircle, NOT_FOUND: ShieldQuestion,
  INVALID_GSTIN: XCircle, TIMEOUT: Clock, MAINTENANCE: AlertTriangle, RATE_LIMITED: Clock, PROVIDER_ERROR: AlertTriangle, NETWORK_ERROR: WifiOff, CAPACITY_LIMITED: Clock,
};

/** Icon + text, never colour alone. Kept separate from verify-panel so list pages do not download the whole verification UI just for a badge. */
export function OutcomeBadge({ outcome }: { outcome: VerificationOutcome }) {
  const e = EXPLANATIONS[outcome]; const Icon = ICON[outcome];
  return <Badge tone={BADGE_TONE[e.tone]} icon={<Icon aria-hidden />}>{e.title}</Badge>;
}
