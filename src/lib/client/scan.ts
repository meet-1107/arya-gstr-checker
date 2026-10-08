// Scanning helpers. The decoding itself is the browser's BarcodeDetector (no dependency, no upload: frames never leave the device).
// Where it is missing (Safari, Firefox, some desktops) the scanner says so and the manual path stays one tap away.
import { extractGstins } from "@/lib/gstin-extract";

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(src: ImageBitmapSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = (new (o?: { formats?: string[] }) => BarcodeDetectorLike) & { getSupportedFormats?: () => Promise<string[]> };

const ctor = (): BarcodeDetectorCtor | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector);

export interface ScanSupport { camera: boolean; detector: boolean }
export function scanSupport(): ScanSupport {
  return { camera: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && (typeof window === "undefined" || window.isSecureContext), detector: !!ctor() };
}

export async function createDetector(): Promise<BarcodeDetectorLike | null> {
  const C = ctor();
  if (!C) return null;
  try {
    const formats = (await C.getSupportedFormats?.()) ?? ["qr_code"];
    return new C({ formats: formats.includes("qr_code") ? ["qr_code"] : formats });
  } catch { return null; }
}

export type ScanReading =
  | { kind: "gstin"; gstin: string; others: string[] }
  | { kind: "no_gstin" }              // decoded something, but it holds no GSTIN
  | { kind: "bad_checksum" };         // looks like a GSTIN but fails the checksum (misread or mistyped)

/** Interprets decoded barcode text. Never guesses: a checksum failure is reported, not "fixed". */
export function readScan(values: string[]): ScanReading {
  const valid: string[] = []; let invalid = 0;
  for (const v of values) { const e = extractGstins(v); for (const g of e.valid) if (!valid.includes(g)) valid.push(g); invalid += e.invalid.length; }
  if (valid.length) return { kind: "gstin", gstin: valid[0], others: valid.slice(1) };
  return invalid ? { kind: "bad_checksum" } : { kind: "no_gstin" };
}

export type CameraFailure = "denied" | "no_camera" | "in_use" | "insecure" | "unknown";
export function cameraFailure(e: unknown): CameraFailure {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no_camera";
  if (name === "NotReadableError" || name === "AbortError") return "in_use";
  return "unknown";
}

export const CAMERA_FAILURE_TEXT: Record<CameraFailure, string> = {
  denied: "Camera access was blocked. You can allow it in your browser's site settings, or type or paste the GSTIN instead.",
  no_camera: "No camera was found on this device. Type or paste the GSTIN instead.",
  in_use: "The camera is busy or couldn't be started. Close other apps using it and try again, or enter the GSTIN manually.",
  insecure: "Camera scanning needs a secure (HTTPS) connection. Type or paste the GSTIN instead.",
  unknown: "The camera couldn't be started. Type or paste the GSTIN instead.",
};
