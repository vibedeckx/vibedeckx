"use client";

import { useEffect } from "react";
import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";
import { ConversationSettingsProvider } from "@/hooks/use-conversation-settings";
import { GlobalEventStreamProvider } from "@/hooks/global-event-stream";
import { ThemeProvider } from "@/hooks/use-theme";
import { ScrollActivity } from "@/components/scroll-activity";
import { markAppMounted } from "@/lib/chunk-recovery";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  // Reaching here means every boot chunk loaded — the chunk-recovery reload
  // count may start counting down to "healthy".
  useEffect(() => markAppMounted(), []);
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
