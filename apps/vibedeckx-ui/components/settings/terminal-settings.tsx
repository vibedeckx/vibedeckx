'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, DEFAULT_TERMINAL_SETTINGS, TERMINAL_SETTINGS_LIMITS, type TerminalSettings } from '@/lib/api';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { useTerminalSettings } from '@/hooks/use-terminal-settings';

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
  const scrollbackValid = Number.isFinite(scrollbackNum) && scrollbackNum >= scrollbackMin && scrollbackNum <= scrollbackMax;
  const fontSizeValid = Number.isFinite(fontSizeNum) && fontSizeNum >= fontSizeMin && fontSizeNum <= fontSizeMax;
  const fontFamilyValid = fontFamily.trim() !== '';
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
      setSaveMessage('Settings saved');
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : 'Failed to save');
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
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium mb-1 block">Scrollback (lines)</label>
        <Input
          type="number"
          min={scrollbackMin}
          max={scrollbackMax}
          value={scrollback}
          onChange={(e) => {
            setScrollback(e.target.value);
            setSaveMessage(null);
          }}
        />
        <p className="text-xs text-muted-foreground mt-1">
          How many output lines the executor terminal keeps in scroll buffer. Range {scrollbackMin}–{scrollbackMax}. Default {DEFAULT_TERMINAL_SETTINGS.scrollback}.
        </p>
      </div>

      <div>
        <label className="text-sm font-medium mb-1 block">Font size (px)</label>
        <Input
          type="number"
          min={fontSizeMin}
          max={fontSizeMax}
          value={fontSize}
          onChange={(e) => {
            setFontSize(e.target.value);
            setSaveMessage(null);
          }}
        />
        <p className="text-xs text-muted-foreground mt-1">
          Range {fontSizeMin}–{fontSizeMax}. Default {DEFAULT_TERMINAL_SETTINGS.fontSize}.
        </p>
      </div>

      <div>
        <label className="text-sm font-medium mb-1 block">Font family</label>
        <Input
          value={fontFamily}
          onChange={(e) => {
            setFontFamily(e.target.value);
            setSaveMessage(null);
          }}
          placeholder={DEFAULT_TERMINAL_SETTINGS.fontFamily}
        />
        <p className="text-xs text-muted-foreground mt-1">
          CSS font-family list. Use monospace fonts for best alignment.
        </p>
      </div>

      {saveMessage && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {saveMessage === 'Settings saved' && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {saveMessage}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={handleReset} disabled={saving}>
          Reset to defaults
        </Button>
        <Button onClick={handleSave} disabled={saving || !canSave}>
          {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
