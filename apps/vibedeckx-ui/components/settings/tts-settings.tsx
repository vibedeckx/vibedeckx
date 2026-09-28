"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, CheckCircle2, ChevronsUpDown, Loader2, Square, Volume2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, TtsRequestError, type TtsSettings, type TtsVoice } from "@/lib/api";
import { ttsPlayer, useTtsState } from "@/lib/tts/tts-player";
import { SettingsActions, SettingsField, SettingsStatus } from "./settings-shell";

const PREVIEW_OWNER = "settings:tts-preview";
const PREVIEW_TEXT = "你好，这是语音朗读的试听。Hello, this is a preview of the selected voice.";

type Drafts = Record<string, Record<string, string>>;
type Dirty = Record<string, Record<string, boolean>>;

/**
 * Speech (read-aloud) settings. Rendered entirely from the server's provider
 * metadata — credential fields, limits and voices — so adding a provider on
 * the backend needs no change here.
 */
export function TtsSettings() {
  const [settings, setSettings] = useState<TtsSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [dirty, setDirty] = useState<Dirty>({});
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const apply = (next: TtsSettings) => {
    setSettings(next);
    setProvider(next.provider);
    setDrafts(next.credentials);
    setDirty({});
    setVoice(next.voice);
    setRate(next.rate);
  };

  useEffect(() => {
    api
      .getTtsSettings()
      .then(apply)
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load speech settings"));
  }, []);

  const providerInfo = settings?.providers.find((p) => p.id === provider);
  const savedConfigured = providerInfo?.configured ?? false;

  // The voice list needs working credentials, so it follows the *saved* state.
  useEffect(() => {
    if (!provider || !savedConfigured) {
      setVoices(null);
      return;
    }
    let cancelled = false;
    setVoicesError(null);
    setVoicesLoading(true);
    api
      .listTtsVoices(provider)
      .then((list) => !cancelled && setVoices(list))
      .finally(() => !cancelled && setVoicesLoading(false))
      .catch((e) => {
        if (cancelled) return;
        setVoices(null);
        setVoicesError(e instanceof TtsRequestError && e.code === "tts_auth_failed"
          ? "The provider rejected these credentials."
          : e instanceof Error ? e.message : "Failed to load voices");
      });
    return () => {
      cancelled = true;
    };
  }, [provider, savedConfigured, settings]);

  const setField = (key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [provider]: { ...prev[provider], [key]: value } }));
    setDirty((prev) => ({ ...prev, [provider]: { ...prev[provider], [key]: true } }));
    setStatus(null);
  };

  const handleProviderChange = (next: string) => {
    setProvider(next);
    const info = settings?.providers.find((p) => p.id === next);
    // A voice belongs to one provider; the server resets it the same way.
    setVoice(next === settings?.provider ? settings.voice : (info?.defaultVoice ?? ""));
    setStatus(null);
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    try {
      const credentials: Drafts = {};
      for (const [id, fields] of Object.entries(dirty)) {
        for (const [key, isDirty] of Object.entries(fields)) {
          if (!isDirty) continue;
          (credentials[id] ??= {})[key] = drafts[id]?.[key] ?? "";
        }
      }
      const updated = await api.updateTtsSettings({
        provider,
        voice,
        rate,
        ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
      });
      apply(updated);
      ttsPlayer.invalidateSettings();
      setStatus({ kind: "success", text: "Settings saved" });
      setTimeout(() => setStatus((s) => (s?.kind === "success" ? null : s)), 2000);
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  };

  const playerState = useTtsState();
  const previewing =
    (playerState.status === "loading" || playerState.status === "playing") && playerState.ownerKey === PREVIEW_OWNER;
  useEffect(() => () => ttsPlayer.stopOwnersWithPrefix(PREVIEW_OWNER), []);
  const previewError = playerState.status === "error" && playerState.ownerKey === PREVIEW_OWNER ? playerState.message : null;

  if (loadError) {
    return (
      <SettingsStatus variant="error" icon={<XCircle className="h-3.5 w-3.5" />}>
        {loadError}
      </SettingsStatus>
    );
  }
  if (!settings || !providerInfo) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const unsavedCredentials = Object.values(dirty[provider] ?? {}).some(Boolean);

  return (
    <div className="space-y-6">
      {settings.providers.length > 1 && (
        <SettingsField label="Provider">
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger className="w-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {settings.providers.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-[12.5px]">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
      )}

      <div className="space-y-4">
        <p className="text-[12px] font-medium text-foreground/70">{providerInfo.label}</p>
        {providerInfo.credentialFields.map((field) => {
          const value = drafts[provider]?.[field.key] ?? "";
          const isDirty = dirty[provider]?.[field.key] ?? false;
          return (
            <SettingsField
              key={field.key}
              label={field.label}
              mono
              hint={field.fromEnv ? "Leave empty to use the server's default." : undefined}
            >
              <Input
                type={field.secret ? "password" : "text"}
                className="font-mono text-[12px]"
                // Secrets show their stored mask as a placeholder; typing replaces them.
                placeholder={field.secret && value && !isDirty ? value : field.placeholder}
                value={field.secret && !isDirty ? "" : value}
                onChange={(e) => setField(field.key, e.target.value)}
                autoComplete="off"
              />
            </SettingsField>
          );
        })}
      </div>

      <SettingsField
        label="Voice"
        hint={
          voicesError ??
          (savedConfigured
            ? "Multilingual voices switch between Chinese and English on their own."
            : "Save your credentials to load the voice list.")
        }
      >
        <VoicePicker value={voice} voices={voices} loading={voicesLoading} disabled={!savedConfigured} onChange={(v) => { setVoice(v); setStatus(null); }} />
      </SettingsField>

      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[12px] font-medium text-foreground/90">Speed</span>
          <span className="font-mono text-[11.5px] text-foreground/80 tabular-nums">{rate.toFixed(2)}×</span>
        </div>
        <Slider
          min={settings.rateRange.min}
          max={settings.rateRange.max}
          step={0.05}
          value={[rate]}
          onValueChange={(v) => {
            setRate(Math.round(v[0] * 100) / 100);
            setStatus(null);
          }}
        />
        <div className="flex justify-between mt-1 text-[10.5px] text-muted-foreground/80 font-mono">
          <span>{settings.rateRange.min}×</span>
          <span>{settings.rateRange.max}×</span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground/85 leading-relaxed">
        When you read a message aloud, its text is sent to {providerInfo.label} for synthesis.
      </p>

      {(status || previewError) && (
        <SettingsStatus
          variant={status?.kind === "success" ? "success" : "error"}
          icon={status?.kind === "success" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        >
          {status?.text ?? previewError}
        </SettingsStatus>
      )}

      <SettingsActions>
        <Button
          size="sm"
          variant="outline"
          // Previews the unsaved voice / speed, but uses the saved credentials.
          disabled={!savedConfigured || unsavedCredentials}
          title={unsavedCredentials ? "Save the credentials first" : undefined}
          onClick={() => ttsPlayer.toggle(PREVIEW_OWNER, PREVIEW_TEXT, { voice, rate })}
        >
          {previewing ? <Square className="h-3.5 w-3.5 mr-1.5" /> : <Volume2 className="h-3.5 w-3.5 mr-1.5" />}
          {previewing ? "Stop" : "Preview"}
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save
        </Button>
      </SettingsActions>
    </div>
  );
}

function VoicePicker({
  value,
  voices,
  loading,
  disabled,
  onChange,
}: {
  value: string;
  voices: TtsVoice[] | null;
  loading: boolean;
  disabled: boolean;
  onChange: (voice: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => voices?.find((v) => v.id === value), [voices, value]);
  const groups = useMemo(() => {
    const list = voices ?? [];
    return [
      { heading: "Multilingual", items: list.filter((v) => v.multilingual) },
      { heading: "All voices", items: list.filter((v) => !v.multilingual) },
    ].filter((g) => g.items.length > 0);
  }, [voices]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-mono text-[12px] font-normal"
        >
          <span className="truncate">{selected?.label ?? value}</span>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
          ) : (
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command>
          <CommandInput placeholder="Search voices…" className="text-[12.5px]" />
          <CommandList className="max-h-72">
            <CommandEmpty>No voice found.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.heading} heading={group.heading}>
                {group.items.map((v) => (
                  <CommandItem
                    key={v.id}
                    value={`${v.label} ${v.id}`}
                    onSelect={() => {
                      onChange(v.id);
                      setOpen(false);
                    }}
                    className="text-[12.5px]"
                  >
                    <Check className={cn("h-3.5 w-3.5", v.id === value ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{v.label}</span>
                    <span className="ml-auto font-mono text-[10.5px] text-muted-foreground truncate">{v.id}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
