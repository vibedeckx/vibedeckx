"use client";

import { useState } from "react";
import { Archive, Bot, Network, Palette, Sparkles, TerminalSquare } from "lucide-react";
import { PageHeader } from "@/components/layout";
import { useAppConfig } from "@/hooks/use-app-config";
import { getPersistedConfig } from "@/lib/api";
import { AppearanceSettings } from "./appearance-settings";
import { ChatProviderSettings } from "./chat-provider-settings";
import { ProxySettings } from "./proxy-settings";
import { TerminalSettingsSection } from "./terminal-settings";
import { AgentProcessSettingsSection } from "./agent-process-settings";
import { SessionRetentionSettingsSection } from "./session-retention-settings";
import {
  SettingsLayout,
  SettingsSection,
  type SettingsNavItem,
} from "./settings-shell";

const NAV: SettingsNavItem[] = [
  { id: "appearance", label: "Appearance", Icon: Palette },
  { id: "ai-chat", label: "AI Chat", Icon: Sparkles },
  { id: "agents", label: "Agents", Icon: Bot },
  { id: "retention", label: "History", Icon: Archive },
  { id: "terminal", label: "Terminal", Icon: TerminalSquare },
  { id: "proxy", label: "Proxy", Icon: Network },
];

export function SettingsView() {
  // In hosted/SaaS mode (--auth) the outbound proxy knob is inert: sessions run
  // on reverse-connected workers, so this front server never dials out through
  // it. Hide the whole Proxy surface there so tenants aren't offered a setting
  // that does nothing — and never even briefly mount ProxySettings (which would
  // fire its own config request) on a null first frame.
  //
  // useAppConfig() starts every fresh hook instance at `config: null` (it reads
  // the cache in an effect, not the initializer). SettingsView only ever mounts
  // after AuthWrapper has already resolved AND persisted the config, so seed the
  // first frame synchronously from that shared, already-resolved value instead
  // of trusting this component's own null first frame. Default to hidden until
  // we positively know auth is OFF, so SaaS is never revealed for a frame; local
  // mode resolves to `authEnabled === false` and shows Proxy without a flash.
  const { config } = useAppConfig();
  const [seededConfig] = useState(getPersistedConfig);
  const proxyHidden = (config ?? seededConfig)?.authEnabled !== false;
  const nav = proxyHidden ? NAV.filter((item) => item.id !== "proxy") : NAV;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <PageHeader
        title="Settings"
        description="Theme, intelligence, terminal, and network preferences."
      />

      <SettingsLayout nav={nav}>
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
          id="retention"
          label="History"
          description="How long finished sessions are kept before they are deleted."
        >
          <SessionRetentionSettingsSection />
        </SettingsSection>

        <SettingsSection
          id="terminal"
          label="Terminal"
          description="Buffer size and typography for the executor terminal."
        >
          <TerminalSettingsSection />
        </SettingsSection>

        {!proxyHidden && (
          <SettingsSection
            id="proxy"
            label="Proxy"
            description="Outbound network routing for AI providers and remote servers."
          >
            <ProxySettings />
          </SettingsSection>
        )}
      </SettingsLayout>
    </div>
  );
}
