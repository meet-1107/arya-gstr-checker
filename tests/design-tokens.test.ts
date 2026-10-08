import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../src/app/globals.css"), "utf8");

/** Extracts `--name: #hex;` declarations from the first block that starts with `selector {`. */
function vars(selector: string): Record<string, string> {
  const start = css.indexOf(selector + " {");
  if (start < 0) throw new Error("selector not found: " + selector);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const light = vars(":root");
const dark = { ...light, ...vars(':root[data-theme="dark"]') };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** [foreground token, background tokens[], minimum ratio] */
const TEXT: [string, string[], number][] = [
  ["foreground", ["background", "surface", "surface-muted", "surface-elevated", "surface-hover"], 4.5],
  ["foreground-muted", ["background", "surface", "surface-muted", "surface-elevated", "surface-hover"], 4.5],
  ["foreground-subtle", ["background", "surface", "surface-muted", "surface-elevated"], 4.5],
  ["primary-foreground", ["primary", "primary-hover"], 4.5],
  ["primary", ["background", "surface", "surface-elevated", "primary-soft"], 4.5],
  ["success-strong", ["background", "surface", "surface-muted", "success-soft"], 4.5],
  ["warning-strong", ["background", "surface", "surface-muted", "warning-soft"], 4.5],
  ["danger-strong", ["background", "surface", "surface-muted", "danger-soft"], 4.5],
  ["info-strong", ["background", "surface", "surface-muted", "info-soft"], 4.5],
  ["success-solid-foreground", ["success-solid", "success-solid-hover"], 4.5],
  ["danger-solid-foreground", ["danger-solid"], 4.5],
  ["inverse-foreground", ["inverse", "inverse-hover", "inverse-active"], 4.5],
  ["inverse-muted", ["inverse", "inverse-hover", "inverse-active"], 4.5],
  ["inverse-subtle", ["inverse", "inverse-hover"], 4.5],
];
/** Non-text indicators (dots, progress fills, icons, focus ring) need 3:1. */
const FILLS: [string, string[], number][] = [
  ["success", ["surface", "background", "inverse"], 3], ["warning", ["surface", "background"], 3], ["danger", ["surface", "background"], 3],
  ["info", ["surface", "background"], 3], ["ring", ["surface", "background", "surface-elevated"], 3],
];

describe.each([["light", light], ["dark", dark]] as const)("WCAG contrast of semantic tokens — %s theme", (_name, t) => {
  for (const [fg, bgs, min] of [...TEXT, ...FILLS]) {
    for (const bg of bgs) {
      it(`${fg} on ${bg} ≥ ${min}:1`, () => {
        expect(t[fg], `--${fg} missing`).toBeTruthy(); expect(t[bg], `--${bg} missing`).toBeTruthy();
        expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

describe("themes are designed, not inverted", () => {
  it("dark defines its own value for every colour token", () => {
    const own = vars(':root[data-theme="dark"]');
    const missing = Object.keys(light).filter((k) => !(k in own) && !["shadow-card-v", "shadow-pop-v", "overlay"].includes(k));
    expect(missing).toEqual([]);
  });
  it("matches the specified identity colours", () => {
    expect(light).toMatchObject({ background: "#f7f9fc", surface: "#ffffff", primary: "#0f3d56", "primary-hover": "#082c3d", success: "#0f9d78", foreground: "#172033", border: "#e2e8f0" });
    expect(dark).toMatchObject({ background: "#07131a", surface: "#0d2029", "surface-elevated": "#122a35", primary: "#3b9ab8", success: "#34c99a", foreground: "#f1f5f9", "foreground-muted": "#9fb0bb", border: "#263d47" });
    expect(light.warning).toBe("#d97706"); expect(light.danger).toBe("#dc2626"); expect(light.info).toBe("#2563eb");
    expect(dark.warning).toBe("#f59e0b"); expect(dark.danger).toBe("#f87171"); expect(dark.info).toBe("#60a5fa");
  });
});

// ---- raw palette is banned in components: only semantic tokens -------------------------------------
function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}
const BANNED = [
  /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|accent|decoration|shadow)-(?:white|black)(?![\w-])/,
  /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|brand|ink)(?:-\d{2,3})?(?:\/\d+)?(?![\w-])/,
  /(?<![\w-])(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]/,
];
describe("components use semantic colour tokens only", () => {
  const files = walk(path.resolve(__dirname, "../src"));
  it("scans the whole frontend", () => expect(files.length).toBeGreaterThan(50));
  it("has no raw palette classes (bg-white, text-slate-*, bg-red-500, text-[#fff], …)", () => {
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        for (const re of BANNED) { const m = re.exec(line); if (m) hits.push(`${path.relative(process.cwd(), f)}:${i + 1}  ${m[0]}`); }
      });
    }
    expect(hits).toEqual([]);
  });
});
