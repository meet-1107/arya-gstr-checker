import { AppError } from "./errors";

export interface AuthUser { uid: string; email: string; emailVerified: boolean; name?: string }

export interface AuthVerifier {
  /** Verify the bearer credential from the request. Throws AppError(UNAUTHENTICATED) when invalid. */
  verify(authorizationHeader: string | null): Promise<AuthUser>;
}

const unauth = () => new AppError("UNAUTHENTICATED", "Please sign in.", 401);

function bearer(h: string | null): string {
  const m = /^Bearer\s+(.+)$/i.exec(h ?? "");
  if (!m) throw unauth();
  return m[1].trim();
}

/** Production verifier: Firebase ID token checked server-side by firebase-admin. */
export class FirebaseAuthVerifier implements AuthVerifier {
  constructor(private getAuth: () => { verifyIdToken(t: string): Promise<{ uid: string; email?: string; email_verified?: boolean; name?: string }> }) {}
  async verify(h: string | null): Promise<AuthUser> {
    const token = bearer(h);
    try {
      const d = await this.getAuth().verifyIdToken(token);
      if (!d.email) throw unauth();
      return { uid: d.uid, email: d.email.toLowerCase(), emailVerified: d.email_verified === true, name: d.name };
    } catch {
      throw unauth();
    }
  }
}

/**
 * Development/test only. Credential format: `Bearer dev:<uid>:<email>[:unverified]`.
 * Refuses to construct in production.
 */
export class DevAuthVerifier implements AuthVerifier {
  constructor(env: Record<string, string | undefined> = process.env) {
    if (env.NODE_ENV === "production") throw new Error("DevAuthVerifier is not allowed in production.");
  }
  async verify(h: string | null): Promise<AuthUser> {
    const t = bearer(h);
    const [prefix, uid, email, flag] = t.split(":");
    if (prefix !== "dev" || !uid || !email) throw unauth();
    return { uid, email: email.toLowerCase(), emailVerified: flag !== "unverified" }; // no display name: UIs derive one from the email
  }
}
