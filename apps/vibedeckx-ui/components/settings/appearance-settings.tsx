"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { useConversationSettings } from "@/hooks/use-conversation-settings";
import { CONVERSATION_SETTINGS_LIMITS, DEFAULT_CONVERSATION_SETTINGS } from "@/lib/api";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import {
  RadioOption,
  SettingsField,
  SettingsRadioCards,
  SettingsActions,
} from "./settings-shell";

const THEME_OPTIONS: ReadonlyArray<RadioOption<Theme>> = [
  { value: "light", label: "Light", description: "Bright surface, true-white cards", Icon: Sun },
  { value: "dark", label: "Dark", description: "Low-light surfaces with deep neutrals", Icon: Moon },
  { value: "system", label: "System", description: "Match your OS preference", Icon: Monitor },
];

const { fontSizeMin, fontSizeMax } = CONVERSATION_SETTINGS_LIMITS;

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();
  const {
    settings,
    setAgentFontSize,
    setChatFontSize,
    setFilesTreeFontSize,
    setFilesContentFontSize,
  } = useConversationSettings();

  const handleReset = () => {
    setAgentFontSize(DEFAULT_CONVERSATION_SETTINGS.agentFontSize);
    setChatFontSize(DEFAULT_CONVERSATION_SETTINGS.chatFontSize);
    setFilesTreeFontSize(DEFAULT_CONVERSATION_SETTINGS.filesTreeFontSize);
    setFilesContentFontSize(DEFAULT_CONVERSATION_SETTINGS.filesContentFontSize);
  };

  return (
    <div className="space-y-6">
      <SettingsField label="Theme" hint="Sets the surface palette across the app. Switching is instant.">
        <SettingsRadioCards
          name="theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={setTheme}
          columns={3}
        />
      </SettingsField>

      <SettingsField
        label="Conversation font size"
        hint="Independent typography for agent and chat views. Affects message body and tool output; chrome elements stay fixed."
      >
        <div className="space-y-5">
          <FontSizeRow
            label="Agent conversation"
            value={settings.agentFontSize}
            onChange={setAgentFontSize}
          />
          <FontSizeRow
            label="Chat session"
            value={settings.chatFontSize}
            onChange={setChatFontSize}
          />
        </div>
      </SettingsField>

      <SettingsField
        label="Files font size"
        hint="Independent typography for the Files tab. Tree controls the file list; content controls the file preview and code."
      >
        <div className="space-y-5">
          <FontSizeRow
            label="File tree"
            value={settings.filesTreeFontSize}
            onChange={setFilesTreeFontSize}
          />
          <FontSizeRow
            label="File content"
            value={settings.filesContentFontSize}
            onChange={setFilesContentFontSize}
          />
        </div>
      </SettingsField>

      <SettingsActions>
        <Button variant="ghost" size="sm" onClick={handleReset}>
          Reset
        </Button>
      </SettingsActions>
    </div>
  );
}

function FontSizeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (px: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[12px] font-medium text-foreground/90">{label}</span>
        <span className="font-mono text-[11.5px] text-foreground/80 tabular-nums">{value} px</span>
      </div>
      <Slider
        min={fontSizeMin}
        max={fontSizeMax}
        step={1}
        value={[value]}
        onValueChange={(v) => onChange(v[0])}
      />
      <div className="flex justify-between mt-1 text-[10.5px] text-muted-foreground/80 font-mono">
        <span>{fontSizeMin}</span>
        <span>{fontSizeMax}</span>
      </div>
    </div>
  );
}
