"use client";

import { useEffect, useState } from "react";
import { isChunkLoadError, requestChunkRecovery, type ChunkRecoveryStatus } from "@/lib/chunk-recovery";

// Shared body of app/error.tsx and app/global-error.tsx. Inline styles with
// system colors on purpose: under global-error the root layout (and with it
// globals.css) may be gone.
export function AppErrorView({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const chunkError = isChunkLoadError(error);
  // recover() is idempotent (one pending recovery per page), so a StrictMode
  // double-invoke of this initializer is harmless.
  const [recovery] = useState<ChunkRecoveryStatus | null>(() =>
    chunkError ? requestChunkRecovery(`${error.name}: ${error.message}`) : null,
  );

  useEffect(() => {
    console.error("[ErrorBoundary]", error);
  }, [error]);

  let title = "Something went wrong";
  let body = error.message;
  if (chunkError) {
    title = recovery === "scheduled" ? "Reconnecting…" : "Couldn't load the app";
    body =
      recovery === "scheduled"
        ? "Part of the app failed to download, most likely because the network dropped. The page will reload by itself once the site is reachable."
        : "Part of the app failed to download. Check your connection, then reload the page.";
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        colorScheme: "light dark",
        background: "Canvas",
        color: "CanvasText",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 12px" }}>{title}</h2>
        <p style={{ fontSize: 14, opacity: 0.7, margin: "0 0 16px" }}>{body}</p>
        <button
          type="button"
          onClick={chunkError ? () => window.location.reload() : reset}
          style={{
            padding: "8px 16px",
            fontSize: 14,
            fontWeight: 500,
            borderRadius: 6,
            border: "1px solid color-mix(in srgb, CanvasText 25%, transparent)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          {chunkError ? "Reload now" : "Try again"}
        </button>
      </div>
    </div>
  );
}
