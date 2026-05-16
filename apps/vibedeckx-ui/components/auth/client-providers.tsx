"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";
import { ThemeProvider } from "@/hooks/use-theme";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthWrapper>
        <TerminalSettingsProvider>
          <BrowserFramesProvider>{children}</BrowserFramesProvider>
        </TerminalSettingsProvider>
      </AuthWrapper>
    </ThemeProvider>
  );
}
