"use client";

import { AuthWrapper } from "./auth-wrapper";
import { BrowserFramesProvider } from "@/components/preview/browser-frames-provider";
import { TerminalSettingsProvider } from "@/hooks/use-terminal-settings";
import { ConversationSettingsProvider } from "@/hooks/use-conversation-settings";
import { GlobalEventStreamProvider } from "@/hooks/global-event-stream";
import { ThemeProvider } from "@/hooks/use-theme";
import { ScrollActivity } from "@/components/scroll-activity";
import { ChunkReloadGuard } from "@/components/chunk-reload-guard";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ScrollActivity />
      <ChunkReloadGuard />
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
