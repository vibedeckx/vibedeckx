"use client";

import { AppErrorView } from "@/components/app-error-view";

// Catches what app/error.tsx can't: errors thrown by the root layout itself
// (e.g. a chunk of ClientProviders failing to load). Replaces the root layout,
// so it renders its own <html>/<body>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <AppErrorView error={error} reset={reset} />
      </body>
    </html>
  );
}
