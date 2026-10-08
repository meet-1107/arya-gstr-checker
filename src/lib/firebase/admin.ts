// SERVER ONLY. Never import from client components.
import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let app: App | undefined;
let db: Firestore | undefined;

function adminApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);
  const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY } = process.env;
  if (projectId && clientEmail && FIREBASE_PRIVATE_KEY) {
    app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") }) });
  } else {
    // Cloud Run / Cloud Functions / local `gcloud auth application-default login`
    app = initializeApp({ credential: applicationDefault(), projectId });
  }
  return app;
}

export function adminFirestore(): Firestore {
  if (db) return db;
  db = getFirestore(adminApp());
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export const adminAuth = () => getAuth(adminApp());
