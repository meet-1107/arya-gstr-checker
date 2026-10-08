"use client";
// Browser-side Firebase (Auth only). Privileged data access always goes through /api.
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

export { firebaseConfigured } from "./configured";

export function clientApp(): FirebaseApp {
  if (getApps().length) return getApp();
  return initializeApp({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  });
}

export const clientAuth = (): Auth => getAuth(clientApp());
