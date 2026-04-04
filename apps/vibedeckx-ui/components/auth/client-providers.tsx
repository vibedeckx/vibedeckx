"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthWrapper>
      <BrowserFramesProvider>{children}</BrowserFramesProvider>
    </AuthWrapper>
  );
}
