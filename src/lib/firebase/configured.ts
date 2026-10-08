// Tiny, SDK-free check shared by the always-loaded auth client. Keep this file free of any `firebase/*` import: pulling the SDK in here would put
// ~43 KB (gzip) on every page, including the landing page and dev-auth sessions. (Measured in milestone 11; see scripts/bundle-report.mjs.)
export const firebaseConfigured = () => !!process.env.NEXT_PUBLIC_FIREBASE_API_KEY && !!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
