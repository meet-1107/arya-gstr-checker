import type { CapacitorConfig } from "@capacitor/cli";

// The app is a server-rendered Next.js site (API routes + store live on the server), so the APK is a thin WebView shell that loads it.
// Set APP_URL when syncing/building: an https URL for a real deployment, or http://<LAN-IP>:3000 / http://10.0.2.2:3000 (emulator) for local testing.
const url = process.env.APP_URL ?? "http://192.168.1.152:3000";

const config: CapacitorConfig = {
  appId: "com.arya.gstrchecker",
  appName: "Arya GSTR Checker",
  webDir: "mobile/www",
  server: { url, cleartext: url.startsWith("http://") },
  android: { allowMixedContent: false },
};
export default config;
