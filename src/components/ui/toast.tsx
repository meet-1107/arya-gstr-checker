"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "success" | "error" | "info";
interface ToastItem { id: number; tone: Tone; title: string; description?: string }
interface Api { toast: (t: Omit<ToastItem, "id">) => void }

const Ctx = createContext<Api>({ toast: () => undefined });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback((t: Omit<ToastItem, "id">) => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 4500);
  }, [dismiss]);
  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:items-end lg:px-6">
        {items.map((t) => {
          const Icon = { success: CheckCircle2, error: AlertTriangle, info: Info }[t.tone];
          return (
            <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className="animate-toast pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-pop">
              <Icon className={cn("mt-0.5 size-4 shrink-0", { success: "text-success-strong", error: "text-danger-strong", info: "text-info-strong" }[t.tone])} aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">{t.title}</p>
                {t.description && <p className="mt-0.5 text-[13px] text-muted">{t.description}</p>}
              </div>
              <button aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="rounded p-1 text-muted hover:bg-surface-hover"><X className="size-3.5" /></button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
