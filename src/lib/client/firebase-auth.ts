"use client";
// Lazy loader so firebase/auth is only downloaded when real Firebase auth is in use.
import { clientAuth } from "@/lib/firebase/client";

export async function fb() {
  const m = await import("firebase/auth");
  return { auth: clientAuth(), m };
}
