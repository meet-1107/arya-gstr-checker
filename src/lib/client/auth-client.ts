"use client";
// Browser-side authentication abstraction.
//  • FirebaseAuthClient — real Firebase Auth (⚠️ UNVERIFIED: no Firebase project/credentials were available).
//  • DevAuthClient      — local-only accounts in localStorage, paired with the server's AUTH_MODE=dev verifier.
// The dev client is chosen when NEXT_PUBLIC_AUTH_MODE=dev or Firebase env is absent, and NEVER in production builds.
import { firebaseConfigured } from "@/lib/firebase/configured"; // NOT ./client: that module statically imports the Firebase SDK

export interface ClientUser { uid: string; email: string; name?: string; emailVerified: boolean }

export class AuthFlowError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface AuthClient {
  readonly mode: "dev" | "firebase" | "unconfigured";
  subscribe(cb: (u: ClientUser | null) => void): () => void;
  getToken(): Promise<string | null>;
  signUp(email: string, password: string, name?: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<{ devLink?: string }>;
  confirmPasswordReset(code: string, newPassword: string): Promise<void>;
  sendVerification(): Promise<void>;
  /** Re-reads the account so a freshly verified email is picked up. */
  reload(): Promise<void>;
  applyActionCode?(code: string): Promise<void>;
  /** Dev-only shortcut for the "click the link in your email" step. */
  devVerifyEmail?(): Promise<void>;
}

// ---- dev ----------------------------------------------------------------------------------------
interface DevAccount { uid: string; email: string; password: string; name?: string; verified: boolean }
const ACCOUNTS = "ca.dev.accounts";
const CURRENT = "ca.dev.current";
const slug = (e: string) => "dev-" + e.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

class DevAuthClient implements AuthClient {
  readonly mode = "dev" as const;
  private listeners = new Set<(u: ClientUser | null) => void>();
  private read(): Record<string, DevAccount> { try { return JSON.parse(localStorage.getItem(ACCOUNTS) ?? "{}"); } catch { return {}; } }
  private write(a: Record<string, DevAccount>) { localStorage.setItem(ACCOUNTS, JSON.stringify(a)); }
  private current(): DevAccount | null {
    const email = localStorage.getItem(CURRENT);
    return email ? this.read()[email] ?? null : null;
  }
  private user(): ClientUser | null {
    const a = this.current();
    return a ? { uid: a.uid, email: a.email, name: a.name, emailVerified: a.verified } : null;
  }
  private emit() { const u = this.user(); this.listeners.forEach((l) => l(u)); }

  subscribe(cb: (u: ClientUser | null) => void) {
    this.listeners.add(cb);
    const onStorage = (e: StorageEvent) => { if (e.key === CURRENT || e.key === ACCOUNTS) cb(this.user()); };
    window.addEventListener("storage", onStorage);
    queueMicrotask(() => cb(this.user()));
    return () => { this.listeners.delete(cb); window.removeEventListener("storage", onStorage); };
  }
  async getToken() {
    const a = this.current();
    return a ? `dev:${a.uid}:${a.email}${a.verified ? "" : ":unverified"}` : null;
  }
  async signUp(email: string, password: string, name?: string) {
    const e = email.trim().toLowerCase();
    const all = this.read();
    if (all[e]) throw new AuthFlowError("auth/email-already-in-use", "An account with this email already exists. Try signing in.");
    all[e] = { uid: slug(e), email: e, password, name: name?.trim() || undefined, verified: false };
    this.write(all); localStorage.setItem(CURRENT, e); this.emit();
  }
  async signIn(email: string, password: string) {
    const e = email.trim().toLowerCase();
    const a = this.read()[e];
    if (!a || a.password !== password) throw new AuthFlowError("auth/invalid-credential", "Incorrect email or password.");
    localStorage.setItem(CURRENT, e); this.emit();
  }
  async signInWithGoogle() {
    const all = this.read();
    const e = "google.user@example.com";
    all[e] ??= { uid: slug(e), email: e, password: "", name: "Google User", verified: true };
    this.write(all); localStorage.setItem(CURRENT, e); this.emit();
  }
  async signOut() { localStorage.removeItem(CURRENT); this.emit(); }
  async sendPasswordReset(email: string) {
    // Mirrors Firebase: never reveal whether the account exists. Dev builds expose the link so the flow is testable.
    return { devLink: `/reset-password?code=${encodeURIComponent("dev:" + email.trim().toLowerCase())}` };
  }
  async confirmPasswordReset(code: string, newPassword: string) {
    const email = code.startsWith("dev:") ? code.slice(4) : "";
    const all = this.read();
    if (!all[email]) throw new AuthFlowError("auth/invalid-action-code", "This reset link is invalid or has expired.");
    all[email].password = newPassword; this.write(all);
  }
  async sendVerification() { /* dev: no email is sent */ }
  async reload() { this.emit(); }
  async devVerifyEmail() {
    const a = this.current();
    if (!a) return;
    const all = this.read(); all[a.email].verified = true; this.write(all); this.emit();
  }
}

// ---- firebase -----------------------------------------------------------------------------------
const FIREBASE_MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/email-already-in-use": "An account with this email already exists. Try signing in.",
  "auth/weak-password": "Choose a stronger password (at least 8 characters).",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
  "auth/popup-closed-by-user": "Sign-in was cancelled.",
  "auth/network-request-failed": "Can't reach the sign-in service. Check your connection.",
  "auth/invalid-action-code": "This link is invalid or has expired.",
  "auth/expired-action-code": "This link has expired. Request a new one.",
};
const wrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    const code = (e as { code?: string }).code ?? "auth/unknown";
    throw new AuthFlowError(code, FIREBASE_MESSAGES[code] ?? "Something went wrong. Please try again.");
  }
};

class FirebaseAuthClient implements AuthClient {
  readonly mode = "firebase" as const;
  private auth = async () => (await import("./firebase-auth")).fb();
  subscribe(cb: (u: ClientUser | null) => void) {
    let off: (() => void) | undefined; let dead = false;
    void this.auth().then(({ auth, m }) => {
      if (dead) return;
      off = m.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: (u.email ?? "").toLowerCase(), name: u.displayName ?? undefined, emailVerified: u.emailVerified } : null));
    });
    return () => { dead = true; off?.(); };
  }
  async getToken() { const { auth } = await this.auth(); return (await auth.currentUser?.getIdToken()) ?? null; }
  signUp(email: string, password: string, name?: string) {
    return wrap(async () => {
      const { auth, m } = await this.auth();
      const cred = await m.createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name?.trim()) await m.updateProfile(cred.user, { displayName: name.trim() });
      await m.sendEmailVerification(cred.user);
    });
  }
  signIn(email: string, password: string) { return wrap(async () => { const { auth, m } = await this.auth(); await m.signInWithEmailAndPassword(auth, email.trim(), password); }); }
  signInWithGoogle() { return wrap(async () => { const { auth, m } = await this.auth(); await m.signInWithPopup(auth, new m.GoogleAuthProvider()); }); }
  signOut() { return wrap(async () => { const { auth, m } = await this.auth(); await m.signOut(auth); }); }
  async sendPasswordReset(email: string) {
    await wrap(async () => { const { auth, m } = await this.auth(); await m.sendPasswordResetEmail(auth, email.trim()); });
    return {};
  }
  confirmPasswordReset(code: string, pw: string) { return wrap(async () => { const { auth, m } = await this.auth(); await m.confirmPasswordReset(auth, code, pw); }); }
  sendVerification() { return wrap(async () => { const { auth, m } = await this.auth(); if (auth.currentUser) await m.sendEmailVerification(auth.currentUser); }); }
  reload() { return wrap(async () => { const { auth } = await this.auth(); await auth.currentUser?.reload(); await auth.currentUser?.getIdToken(true); }); }
  applyActionCode(code: string) { return wrap(async () => { const { auth, m } = await this.auth(); await m.applyActionCode(auth, code); }); }
}

/**
 * Production build without Firebase configuration: dev auth is NOT allowed, and real auth is impossible.
 * Fails closed — nobody can sign in — but the public site still renders and builds.
 */
class UnconfiguredAuthClient implements AuthClient {
  readonly mode = "unconfigured" as const;
  private fail = (): never => { throw new AuthFlowError("auth/not-configured", "Sign-in isn't configured on this deployment yet."); };
  subscribe(cb: (u: ClientUser | null) => void) { queueMicrotask(() => cb(null)); return () => undefined; }
  async getToken() { return null; }
  async signUp(): Promise<void> { return this.fail(); }
  async signIn(): Promise<void> { return this.fail(); }
  async signInWithGoogle(): Promise<void> { return this.fail(); }
  async signOut() { /* nothing to do */ }
  async sendPasswordReset(): Promise<{ devLink?: string }> { return this.fail(); }
  async confirmPasswordReset(): Promise<void> { return this.fail(); }
  async sendVerification(): Promise<void> { return this.fail(); }
  async reload() { /* nothing to do */ }
}

let instance: AuthClient | undefined;
export function getAuthClient(): AuthClient {
  if (instance) return instance;
  const devRequested = process.env.NEXT_PUBLIC_AUTH_MODE === "dev";
  const useDev = process.env.NODE_ENV !== "production" && (devRequested || !firebaseConfigured());
  if (!useDev && !firebaseConfigured()) return (instance = new UnconfiguredAuthClient());
  return (instance = useDev ? new DevAuthClient() : new FirebaseAuthClient());
}
