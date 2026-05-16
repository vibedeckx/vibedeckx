"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { RadioOption, SettingsField, SettingsRadioCards } from "./settings-shell";

const THEME_OPTIONS: ReadonlyArray<RadioOption<Theme>> = [
  { value: "light", label: "Light", description: "Bright surface, true-white cards", Icon: Sun },
  { value: "dark", label: "Dark", description: "Low-light surfaces with deep neutrals", Icon: Moon },
  { value: "system", label: "System", description: "Match your OS preference", Icon: Monitor },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <SettingsField label="Theme" hint="Sets the surface palette across the app. Switching is instant.">
      <SettingsRadioCards
        name="theme"
        value={theme}
        options={THEME_OPTIONS}
        onChange={setTheme}
        columns={3}
      />
    </SettingsField>
  );
}
