"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { isThemePref, resolveTheme, THEME_STORAGE_KEY, type ResolvedTheme, type ThemePref } from "@/lib/client/theme";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";

interface ThemeValue { pref: ThemePref; resolved: ResolvedTheme; setPref: (p: ThemePref) => void }
const Ctx = createContext<ThemeValue | null>(null);
export const useTheme = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
};

const EVENT = "ca:theme";
const readPref = (): ThemePref => { try { const v = localStorage.getItem(THEME_STORAGE_KEY); return isThemePref(v) ? v : "system"; } catch { return "system"; } };
const subscribePref = (cb: () => void) => { window.addEventListener("storage", cb); window.addEventListener(EVENT, cb); return () => { window.removeEventListener("storage", cb); window.removeEventListener(EVENT, cb); }; };
const mql = () => window.matchMedia("(prefers-color-scheme: dark)");
const subscribeSystem = (cb: () => void) => { const m = mql(); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };

export function ThemeProvider({ children }: { children: ReactNode }) {
  const pref = useSyncExternalStore(subscribePref, readPref, () => "system" as ThemePref);
  const systemDark = useSyncExternalStore(subscribeSystem, () => mql().matches, () => false);
  const resolved = resolveTheme(pref, systemDark);

  // Keep <html> in sync (the init script already set it before first paint).
  useEffect(() => {
    const r = document.documentElement;
    if (r.dataset.theme === resolved) return;
    r.classList.add("theme-transition"); // ease between themes for ~200 ms (never on first paint)
    r.dataset.theme = resolved; r.style.colorScheme = resolved;
    const t = setTimeout(() => r.classList.remove("theme-transition"), 220);
    return () => clearTimeout(t);
  }, [resolved]);

  const setPref = useCallback((p: ThemePref) => {
    try { localStorage.setItem(THEME_STORAGE_KEY, p); } catch { /* private mode: applies for this session only */ }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  const value = useMemo(() => ({ pref, resolved, setPref }), [pref, resolved, setPref]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }, { value: "system", label: "System", icon: Monitor },
];

/** Icon button + menu (Light / Dark / System). Used on marketing, auth and app chrome. */
export function ThemeToggle({ className }: { className?: string }) {
  const { pref, resolved, setPref } = useTheme();
  const Icon = resolved === "dark" ? Moon : Sun;
  return (
    <Menu>
      <MenuTrigger className={cn("rounded-lg p-2 text-muted hover:bg-surface-hover hover:text-foreground", className)} aria-label={`Theme: ${pref}. Change theme`}>
        <Icon className="size-[18px]" aria-hidden />
      </MenuTrigger>
      <MenuContent className="w-40">
        <MenuLabel>Theme</MenuLabel>
        {OPTIONS.map((o) => (
          <MenuItem key={o.value} onSelect={() => setPref(o.value)}>
            <o.icon />{o.label}{pref === o.value && <Check className="ml-auto !text-success-strong" aria-label="Selected" />}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
