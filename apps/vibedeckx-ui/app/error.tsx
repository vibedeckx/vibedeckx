"use client";

import { AppErrorView } from "@/components/app-error-view";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorView error={error} reset={reset} />;
}
