"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";
import { ConversationSettingsProvider } from "@/hooks/use-conversation-settings";
import { ThemeProvider } from "@/hooks/use-theme";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthWrapper>
        <TerminalSettingsProvider>
          <ConversationSettingsProvider>
            <BrowserFramesProvider>{children}</BrowserFramesProvider>
          </ConversationSettingsProvider>
        </TerminalSettingsProvider>
      </AuthWrapper>
    </ThemeProvider>
  );
}
