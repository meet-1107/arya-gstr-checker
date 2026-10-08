import { describe, beforeAll } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { storeContract } from "./store-contract";

storeContract("MemoryStore", () => new MemoryStore());

// FirestoreStore runs the SAME contract when a Firebase emulator is available:
//   firebase emulators:exec --only firestore "npm test"      (needs Java + firebase-tools)
// Without FIRESTORE_EMULATOR_HOST this block is skipped — Firestore is therefore UNVERIFIED in CI today.
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
describe.skipIf(!emulator)("FirestoreStore (emulator)", () => {
  let make: () => Store;
  beforeAll(async () => {
    const { initializeApp, getApps } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const { FirestoreStore } = await import("@/lib/store/firestore");
    const app = getApps()[0] ?? initializeApp({ projectId: "demo-gst-ca" });
    const db = getFirestore(app);
    try { db.settings({ ignoreUndefinedProperties: true }); } catch { /* already configured */ }
    make = () => new FirestoreStore(db);
  });
  storeContract("FirestoreStore", () => make());
});
