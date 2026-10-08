import { describe, expect, it } from "vitest";
import { isThemePref, resolveTheme, themeInitScript, THEME_STORAGE_KEY } from "@/lib/client/theme";

describe("resolveTheme", () => {
  it("explicit preferences win over the system setting", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("system follows the OS", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
  it("unknown stored values fall back to system", () => {
    expect(resolveTheme("purple", true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(isThemePref("purple")).toBe(false);
  });
  it("the no-flash script reads the same storage key and always sets data-theme", () => {
    expect(themeInitScript).toContain(THEME_STORAGE_KEY);
    expect(themeInitScript).toContain("dataset.theme");
  });
});
