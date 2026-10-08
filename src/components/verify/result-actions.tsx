"use client";
import { useState } from "react";
import { Bookmark, BookmarkCheck, Copy, Download, Mail, MessageCircle, Send, Share2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { BRAND } from "@/config/brand";
import { errorMessage } from "@/lib/client/api";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import { buildShareText, isShareable, mailtoUrl, telegramUrl, whatsappUrl } from "@/lib/share";
import { type VerificationView } from "@/lib/verification";

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* clipboard blocked: fall through */ }
  try {
    const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok;
  } catch { return false; }
}

export function CopyGstin({ gstin }: { gstin: string }) {
  const { toast } = useToast();
  return (
    <Button size="sm" variant="ghost" aria-label={`Copy GSTIN ${gstin}`} onClick={async () => toast(await copy(gstin) ? { tone: "success", title: "GSTIN copied" } : { tone: "error", title: "Couldn't copy", description: "Select the GSTIN and copy it manually." })}>
      <Copy className="size-3.5" aria-hidden />Copy
    </Button>
  );
}

/** Pin / unpin (organization-wide). Optimistic label, rolled back on error. */
export function SaveButton({ view, canSave, onChange }: { view: VerificationView; canSave: boolean; onChange?: (saved: boolean) => void }) {
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [saved, setSaved] = useState(view.saved === true);
  const [busy, setBusy] = useState(false);
  if (!isShareable(view)) return null; // only a stored registry answer can be saved
  const toggle = async () => {
    setBusy(true); const next = !saved;
    try {
      await call("/api/verify/save", { method: "POST", body: { gstin: view.gstin, saved: next } });
      setSaved(next); onChange?.(next); void invalidate("/api/verify/recent");
      toast({ tone: "success", title: next ? "Saved" : "Removed from saved", description: view.gstin });
    } catch (e) { toast({ tone: "error", title: "Couldn't update saved list", description: errorMessage(e) }); }
    finally { setBusy(false); }
  };
  return (
    <Button size="sm" variant="secondary" loading={busy} disabled={!canSave} aria-pressed={saved} onClick={() => void toggle()}>
      {saved ? <BookmarkCheck className="size-3.5" aria-hidden /> : <Bookmark className="size-3.5" aria-hidden />}{saved ? "Saved" : "Save"}
    </Button>
  );
}

export function ShareMenu({ view }: { view: VerificationView }) {
  const { toast } = useToast();
  if (!isShareable(view)) return null;
  const text = buildShareText({ view, appName: BRAND.name });
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const image = async () => (await import("@/lib/client/share-card")).renderShareCard(view, BRAND.name); // canvas code only when sharing
  const nativeShare = async () => {
    try {
      const blob = await image();
      const file = blob ? new File([blob], `gst-${view.gstin}.png`, { type: "image/png" }) : null;
      if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text, title: "GST verification" });
      else await navigator.share({ text, title: "GST verification" });
    } catch (e) { if ((e as { name?: string }).name !== "AbortError") toast({ tone: "error", title: "Couldn't open sharing", description: "Use Copy text instead." }); }
  };
  const saveImage = async () => {
    const blob = await image();
    if (!blob) { toast({ tone: "error", title: "Couldn't create the image" }); return; }
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `gst-verification-${view.gstin}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Menu>
      <MenuTrigger className={buttonClass("secondary", "sm")} aria-label="Share this result"><Share2 className="size-3.5" aria-hidden />Share</MenuTrigger>
      <MenuContent className="w-56">
        <MenuLabel>Share this result</MenuLabel>
        {canNativeShare && <MenuItem onSelect={() => void nativeShare()}><Share2 />Share…</MenuItem>}
        <MenuItem onSelect={async () => toast(await copy(text) ? { tone: "success", title: "Copied to clipboard" } : { tone: "error", title: "Couldn't copy" })}><Copy />Copy text</MenuItem>
        <MenuItem asChild><a href={whatsappUrl(text)} target="_blank" rel="noopener noreferrer"><MessageCircle />WhatsApp</a></MenuItem>
        <MenuItem asChild><a href={telegramUrl(text)} target="_blank" rel="noopener noreferrer"><Send />Telegram</a></MenuItem>
        <MenuItem asChild><a href={mailtoUrl(`GST verification: ${view.gstin}`, text)}><Mail />Email</a></MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => void saveImage()}><Download />Download as image</MenuItem>
      </MenuContent>
    </Menu>
  );
}
