export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "ca.theme";

export const isThemePref = (v: unknown): v is ThemePref => v === "light" || v === "dark" || v === "system";

/** `system` follows the OS; anything else is explicit. Unknown stored values fall back to `system`. */
export function resolveTheme(pref: unknown, systemDark: boolean): ResolvedTheme {
  const p: ThemePref = isThemePref(pref) ? pref : "system";
  return p === "dark" || (p === "system" && systemDark) ? "dark" : "light";
}

/**
 * Runs synchronously in <head> BEFORE first paint so the page never flashes the wrong theme.
 * Keep it dependency-free; it is inlined as a string.
 */
export const themeInitScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=p==="dark"||((p!=="light")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light"}catch(e){}})()`;
