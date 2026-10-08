"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImageUp, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/feedback";
import { Dialog } from "@/components/ui/overlay";
import { CAMERA_FAILURE_TEXT, cameraFailure, createDetector, readScan, scanSupport, type CameraFailure } from "@/lib/client/scan";

type Phase = { name: "intro" } | { name: "starting" } | { name: "scanning" } | { name: "failed"; why: CameraFailure };

const HINT = { no_gstin: "That QR code doesn't contain a GSTIN. Try the code printed on the invoice or registration certificate.", bad_checksum: "A GSTIN was read but its check character doesn't match, so it was probably misread. Hold steady and try again." } as const;

/**
 * Camera / photo scanner. Nothing happens until the user taps a button INSIDE this dialog: opening the app or the dialog never
 * requests the camera. Frames are decoded on the device and never uploaded. Every dead end offers "Enter GSTIN manually".
 */
export function GstinScanner({ open, onOpenChange, onFound }: { open: boolean; onOpenChange: (o: boolean) => void; onFound: (gstin: string, others: string[]) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Scan a GSTIN" description="Point the camera at the QR code on an invoice or GST certificate.">
      {open && <ScannerBody onClose={() => onOpenChange(false)} onFound={(g, o) => { onOpenChange(false); onFound(g, o); }} />}
    </Dialog>
  );
}

function ScannerBody({ onClose, onFound }: { onClose: () => void; onFound: (g: string, others: string[]) => void }) {
  const [phase, setPhase] = useState<Phase>({ name: "intro" });
  const [hint, setHint] = useState<string | null>(null);
  const [support] = useState(scanSupport);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const done = useRef(false);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current); timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const handle = useCallback((values: string[]) => {
    if (done.current) return;
    const r = readScan(values);
    if (r.kind === "gstin") { done.current = true; stop(); onFound(r.gstin, r.others); }
    else setHint(HINT[r.kind]);
  }, [onFound, stop]);

  const startCamera = async () => {
    if (!support.camera) { setPhase({ name: "failed", why: typeof window !== "undefined" && !window.isSecureContext ? "insecure" : "no_camera" }); return; }
    setPhase({ name: "starting" }); setHint(null);
    try {
      const detector = await createDetector();
      if (!detector) { setPhase({ name: "failed", why: "unknown" }); return; }
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      stream.current = s;
      setPhase({ name: "scanning" });
      requestAnimationFrame(() => {
        const v = video.current; if (!v) return;
        v.srcObject = s; void v.play().catch(() => undefined);
        timer.current = setInterval(async () => {
          if (v.readyState < 2 || done.current) return;
          try { const found = await detector.detect(v); if (found.length) handle(found.map((f) => f.rawValue)); } catch { /* a frame failed to decode: keep scanning */ }
        }, 300);
      });
    } catch (e) { stop(); setPhase({ name: "failed", why: cameraFailure(e) }); }
  };

  const fromPhoto = async (file: File | undefined) => {
    if (!file) return;
    setHint(null);
    const detector = await createDetector();
    if (!detector) { setHint("This browser can't read QR codes from photos. Type or paste the GSTIN instead."); return; }
    try {
      const bmp = await createImageBitmap(file);
      const found = await detector.detect(bmp); bmp.close();
      if (!found.length) { setHint("No QR code was found in that photo. Use a sharp, well-lit photo of the code, or enter the GSTIN manually."); return; }
      handle(found.map((f) => f.rawValue));
    } catch { setHint("That image couldn't be read. Try another photo, or enter the GSTIN manually."); }
  };

  return (
    <div className="space-y-4">
      {phase.name === "intro" && (
        <>
          <p className="text-sm">Camera access is used only to scan GSTINs and GST QR codes. Images are read on your device and are not recorded or uploaded.</p>
          {!support.detector && <Alert tone="info" title="Automatic scanning isn't available in this browser">Type or paste the GSTIN instead. QR scanning works in Chrome and Edge on most phones and computers.</Alert>}
          <div className="flex flex-col gap-2 sm:flex-row">
            {support.detector && support.camera && <Button variant="primary" onClick={() => void startCamera()}><Camera className="size-4" aria-hidden />Open camera</Button>}
            {support.detector && (
              <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium shadow-card hover:bg-surface-hover focus-within:ring-2 focus-within:ring-ring">
                <ImageUp className="size-4" aria-hidden />Choose a photo
                <input type="file" accept="image/*" className="sr-only" onChange={(e) => void fromPhoto(e.target.files?.[0])} />
              </label>
            )}
            <Button variant="secondary" onClick={onClose}><Keyboard className="size-4" aria-hidden />Enter GSTIN manually</Button>
          </div>
        </>
      )}
      {phase.name === "starting" && <p className="flex items-center gap-2 text-sm" role="status"><Spinner />Starting the camera… allow access if your browser asks.</p>}
      {phase.name === "scanning" && (
        <>
          <div className="relative overflow-hidden rounded-xl bg-inverse">
            <video ref={video} playsInline muted className="aspect-[4/3] w-full object-cover" aria-label="Camera preview" />
            <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-inverse-foreground/70" aria-hidden />
          </div>
          <p className="text-sm text-muted" role="status">Looking for a QR code… hold it inside the frame.</p>
          <Button variant="secondary" onClick={onClose}><Keyboard className="size-4" aria-hidden />Can&apos;t scan? Enter GSTIN manually</Button>
        </>
      )}
      {phase.name === "failed" && (
        <>
          <Alert tone="warning" title="Can't use the camera">{CAMERA_FAILURE_TEXT[phase.why]}</Alert>
          <div className="flex flex-col gap-2 sm:flex-row">
            {phase.why !== "no_camera" && phase.why !== "insecure" && <Button variant="secondary" onClick={() => void startCamera()}>Try again</Button>}
            <Button variant="primary" onClick={onClose}><Keyboard className="size-4" aria-hidden />Enter GSTIN manually</Button>
          </div>
        </>
      )}
      {hint && <Alert tone="info">{hint}</Alert>}
    </div>
  );
}
