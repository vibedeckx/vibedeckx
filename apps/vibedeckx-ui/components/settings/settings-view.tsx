"use client";

import { Bot, Network, Palette, Sparkles, TerminalSquare } from "lucide-react";
import { PageHeader } from "@/components/layout";
import { AppearanceSettings } from "./appearance-settings";
import { ChatProviderSettings } from "./chat-provider-settings";
import { ProxySettings } from "./proxy-settings";
import { TerminalSettingsSection } from "./terminal-settings";
import { AgentProcessSettingsSection } from "./agent-process-settings";
import {
  SettingsLayout,
  SettingsSection,
  type SettingsNavItem,
} from "./settings-shell";

const NAV: SettingsNavItem[] = [
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "ai-chat", label: "AI Chat", Icon: Sparkles },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "terminal", label: "Terminal", Icon: TerminalSquare },
  { id: "proxy", label: "Proxy", Icon: Network },
];

export function SettingsView() {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <PageHeader
        title="Settings"
        description="Theme, intelligence, terminal, and network preferences."
      />

      <SettingsLayout nav={NAV}>
        <SettingsSection
          id="appearance"
          label="Appearance"
          description="Visual surface for the workspace. Affects every view."
        >
          <AppearanceSettings />
        </SettingsSection>

        <SettingsSection
          id="ai-chat"
          label="AI Chat"
          description="Provider, credentials, and default model used for the orchestrator chat."
        >
          <ChatProviderSettings />
        </SettingsSection>

        <SettingsSection
          id="agents"
          label="Agents"
          description="Resident coding-agent process limits per workspace branch."
        >
          <AgentProcessSettingsSection />
        </SettingsSection>

        <SettingsSection
          id="terminal"
          label="Terminal"
          description="Buffer size and typography for the executor terminal."
        >
          <TerminalSettingsSection />
        </SettingsSection>

        <SettingsSection
          id="proxy"
          label="Proxy"
          description="Outbound network routing for AI providers and remote servers."
        >
          <ProxySettings />
        </SettingsSection>
      </SettingsLayout>
    </div>
  );
}
