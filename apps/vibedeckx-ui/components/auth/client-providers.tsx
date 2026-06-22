"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";
import { ConversationSettingsProvider } from "@/hooks/use-conversation-settings";
import { GlobalEventStreamProvider } from "@/hooks/global-event-stream";
import { ThemeProvider } from "@/hooks/use-theme";
import { ScrollActivity } from "@/components/scroll-activity";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ScrollActivity />
      <AuthWrapper>
        <TerminalSettingsProvider>
          <ConversationSettingsProvider>
            <BrowserFramesProvider>
              <GlobalEventStreamProvider>{children}</GlobalEventStreamProvider>
            </BrowserFramesProvider>
          </ConversationSettingsProvider>
        </TerminalSettingsProvider>
      </AuthWrapper>
    </ThemeProvider>
  );
}
