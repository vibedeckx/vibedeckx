"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthWrapper>
      <TerminalSettingsProvider>
        <BrowserFramesProvider>{children}</BrowserFramesProvider>
      </TerminalSettingsProvider>
    </AuthWrapper>
  );
}
