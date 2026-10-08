"use client";

/** Fallback when even the root layout fails. It must render its own <html>/<body> and cannot rely on the app's CSS or providers, so it is plain. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f7f9fc", color: "#172033" }}>
        <main style={{ maxWidth: 420, margin: "0 auto", minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 16px", textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Something went wrong on our side</h1>
          <p style={{ color: "#56667c", fontSize: 14 }}>The app couldn&apos;t start. Your data hasn&apos;t been changed.</p>
          {error.digest && <p style={{ color: "#56667c", fontSize: 12 }}>Reference: <code>{error.digest}</code></p>}
          <div><button type="button" onClick={reset} style={{ height: 40, padding: "0 16px", borderRadius: 8, border: 0, background: "#0f3d56", color: "#fff", fontSize: 14, cursor: "pointer" }}>Try again</button></div>
        </main>
      </body>
    </html>
  );
}
