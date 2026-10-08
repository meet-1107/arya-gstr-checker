import type { NextConfig } from "next";

const prod = process.env.NODE_ENV === "production";

/**
 * Security headers. The CSP is REPORT-ONLY on purpose: it logs violations in the browser console without blocking anything, because it has not
 * been exercised against a real Firebase sign-in (popup/redirect domains may need adding) and Next's hydration needs inline scripts. Tighten it
 * (nonces, drop 'unsafe-inline') and switch to enforcing only after checking a real deployment's console for violations.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${prod ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com",
  "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  // Lets a production build go to its own folder (NEXT_DIST_DIR=.next-build npm run build) so it never invalidates a running dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Dev server only: lets the Android WebView / phones on the LAN load /_next assets from this machine.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        // The scanner needs the camera on our own origin only; nothing else needs sensors or payments.
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()" },
        // "allow-popups" keeps Firebase's Google sign-in popup working.
        { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        { key: "Content-Security-Policy-Report-Only", value: csp },
        ...(prod ? [{ key: "Strict-Transport-Security", value: "max-age=15552000" }] : []),
      ],
    }];
  },
};

export default nextConfig;
