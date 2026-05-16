"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SETTINGS_LIMITS,
  type TerminalSettings,
} from "@/lib/api";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTerminalSettings } from "@/hooks/use-terminal-settings";
import {
  SettingsActions,
  SettingsField,
  SettingsStatus,
} from "./settings-shell";

const { scrollbackMin, scrollbackMax, fontSizeMin, fontSizeMax } = TERMINAL_SETTINGS_LIMITS;

export function TerminalSettingsSection() {
  const { settings, loaded, refresh } = useTerminalSettings();
  const [scrollback, setScrollback] = useState(String(DEFAULT_TERMINAL_SETTINGS.scrollback));
  const [fontSize, setFontSize] = useState(String(DEFAULT_TERMINAL_SETTINGS.fontSize));
  const [fontFamily, setFontFamily] = useState(DEFAULT_TERMINAL_SETTINGS.fontFamily);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) return;
    setScrollback(String(settings.scrollback));
    setFontSize(String(settings.fontSize));
    setFontFamily(settings.fontFamily);
  }, [loaded, settings.scrollback, settings.fontSize, settings.fontFamily]);

  const scrollbackNum = parseInt(scrollback, 10);
  const fontSizeNum = parseInt(fontSize, 10);
  const scrollbackValid =
    Number.isFinite(scrollbackNum) && scrollbackNum >= scrollbackMin && scrollbackNum <= scrollbackMax;
  const fontSizeValid =
    Number.isFinite(fontSizeNum) && fontSizeNum >= fontSizeMin && fontSizeNum <= fontSizeMax;
  const fontFamilyValid = fontFamily.trim() !== "";
  const canSave = scrollbackValid && fontSizeValid && fontFamilyValid;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const payload: Partial<TerminalSettings> = {
        scrollback: scrollbackNum,
        fontSize: fontSizeNum,
        fontFamily: fontFamily.trim(),
      };
      await api.updateTerminalSettings(payload);
      await refresh();
      setSaveMessage("Settings saved");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setScrollback(String(DEFAULT_TERMINAL_SETTINGS.scrollback));
    setFontSize(String(DEFAULT_TERMINAL_SETTINGS.fontSize));
    setFontFamily(DEFAULT_TERMINAL_SETTINGS.fontFamily);
    setSaveMessage(null);
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <SettingsField
          label="Scrollback"
          mono
          hint={
            <span>
              Lines kept in buffer.{" "}
              <span className="font-mono text-foreground/70">
                {scrollbackMin}–{scrollbackMax}
              </span>
              {" · default "}
              <span className="font-mono text-foreground/70">{DEFAULT_TERMINAL_SETTINGS.scrollback}</span>
            </span>
          }
        >
          <Input
            type="number"
            min={scrollbackMin}
            max={scrollbackMax}
            value={scrollback}
            className="font-mono text-[12.5px]"
            onChange={(e) => {
              setScrollback(e.target.value);
              setSaveMessage(null);
            }}
          />
        </SettingsField>

        <SettingsField
          label="Font size"
          mono
          hint={
            <span>
              Pixels.{" "}
              <span className="font-mono text-foreground/70">
                {fontSizeMin}–{fontSizeMax}
              </span>
              {" · default "}
              <span className="font-mono text-foreground/70">{DEFAULT_TERMINAL_SETTINGS.fontSize}</span>
            </span>
          }
        >
          <Input
            type="number"
            min={fontSizeMin}
            max={fontSizeMax}
            value={fontSize}
            className="font-mono text-[12.5px]"
            onChange={(e) => {
              setFontSize(e.target.value);
              setSaveMessage(null);
            }}
          />
        </SettingsField>
      </div>

      <SettingsField
        label="Font family"
        mono
        hint="CSS font-family list. Use monospace fonts for column alignment."
      >
        <Input
          value={fontFamily}
          className="font-mono text-[12px]"
          onChange={(e) => {
            setFontFamily(e.target.value);
            setSaveMessage(null);
          }}
          placeholder={DEFAULT_TERMINAL_SETTINGS.fontFamily}
        />
      </SettingsField>

      {saveMessage && (
        <SettingsStatus
          variant={saveMessage === "Settings saved" ? "success" : "error"}
          icon={
            saveMessage === "Settings saved" ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )
          }
        >
          {saveMessage}
        </SettingsStatus>
      )}

      <SettingsActions>
        <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
          Reset to defaults
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !canSave}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save changes
        </Button>
      </SettingsActions>
    </div>
  );
}
