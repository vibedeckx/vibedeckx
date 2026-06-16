"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  PROVIDERS,
  PROVIDER_IDS,
  defaultChatProviderConfig,
  defaultModelChoice,
  type ChatProviderConfig,
  type ModelChoice,
  type ProviderId,
} from "@/lib/api";
import { CheckCircle2, Loader2, Sparkles, Waypoints, XCircle, type LucideIcon } from "lucide-react";
import {
  RadioOption,
  SettingsActions,
  SettingsField,
  SettingsRadioCards,
  SettingsStatus,
} from "./settings-shell";

const PROVIDER_ICONS: Record<ProviderId, LucideIcon> = {
  deepseek: Sparkles,
  openrouter: Waypoints,
};

const PROVIDER_OPTIONS: ReadonlyArray<RadioOption<ProviderId>> = PROVIDER_IDS.map((id) => ({
  value: id,
  label: PROVIDERS[id].label,
  description:
    id === "deepseek"
      ? "Direct API access — lowest latency"
      : "Aggregator routing — many models available",
  Icon: PROVIDER_ICONS[id],
}));

/** Provider radio + model selector for one model slot (main or fast). */
function ModelSlot({
  name,
  value,
  onChange,
}: {
  name: string;
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
}) {
  const def = PROVIDERS[value.provider];
  return (
    <div className="space-y-3">
      <SettingsRadioCards
        name={name}
        value={value.provider}
        options={PROVIDER_OPTIONS}
        onChange={(provider) => onChange(defaultModelChoice(provider))}
        columns={2}
      />
      {def.models ? (
        <Select value={value.model} onValueChange={(model) => onChange({ ...value, model })}>
          <SelectTrigger className="w-full font-mono text-[12.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.models.map((model) => (
              <SelectItem key={model} value={model} className="font-mono text-[12.5px]">
                {def.modelLabels?.[model] ?? model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          className="font-mono text-[12.5px]"
          placeholder={def.placeholder}
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      )}
    </div>
  );
}

export function ChatProviderSettings() {
  const [apiKeys, setApiKeys] = useState<Record<ProviderId, string>>(() =>
    defaultChatProviderConfig().apiKeys,
  );
  const [keyDirty, setKeyDirty] = useState<Record<ProviderId, boolean>>(() => ({
    deepseek: false,
    openrouter: false,
  }));
  const [main, setMain] = useState<ModelChoice>(() => defaultModelChoice());
  const [fast, setFast] = useState<ModelChoice>(() => defaultModelChoice());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .getChatProviderSettings()
      .then((config) => {
        setApiKeys(config.apiKeys);
        setMain(config.main);
        setFast(config.fast);
        setKeyDirty({ deepseek: false, openrouter: false });
      })
      .finally(() => setLoading(false));
  }, []);

  const clearMessage = () => setSaveMessage(null);

  const handleKeyChange = (provider: ProviderId, value: string) => {
    setApiKeys((prev) => ({ ...prev, [provider]: value }));
    setKeyDirty((prev) => ({ ...prev, [provider]: true }));
    clearMessage();
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const dirtyKeys: Partial<Record<ProviderId, string>> = {};
      for (const id of PROVIDER_IDS) {
        if (keyDirty[id]) dirtyKeys[id] = apiKeys[id];
      }
      const payload: Partial<ChatProviderConfig> = { main, fast };
      if (Object.keys(dirtyKeys).length > 0) {
        payload.apiKeys = dirtyKeys as Record<ProviderId, string>;
      }

      const updated = await api.updateChatProviderSettings(payload);
      setApiKeys(updated.apiKeys);
      setMain(updated.main);
      setFast(updated.fast);
      setKeyDirty({ deepseek: false, openrouter: false });
      setSaveMessage("Settings saved");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <p className="text-[12px] font-medium text-foreground/70">API keys</p>
        {PROVIDER_IDS.map((id) => {
          const def = PROVIDERS[id];
          const dirty = keyDirty[id];
          const stored = apiKeys[id];
          return (
            <SettingsField
              key={id}
              label={`${def.label} API key`}
              mono
              hint={
                <>
                  Leave empty to fall back to the{" "}
                  <code className="font-mono text-[10.5px] bg-muted/60 border border-border/60 rounded px-1 py-px">
                    {def.envKey}
                  </code>{" "}
                  environment variable.
                </>
              }
            >
              <Input
                type="password"
                className="font-mono text-[12px]"
                placeholder={stored && !dirty ? stored : "sk-..."}
                value={dirty ? stored : ""}
                onChange={(e) => handleKeyChange(id, e.target.value)}
              />
            </SettingsField>
          );
        })}
      </div>

      <SettingsField
        label="Main model"
        hint="Powers the chat session."
      >
        <ModelSlot
          name="main-provider"
          value={main}
          onChange={(next) => {
            setMain(next);
            clearMessage();
          }}
        />
      </SettingsField>

      <SettingsField
        label="Fast model"
        hint="Powers translate and agent session titles. Can use a different provider than the main model."
      >
        <ModelSlot
          name="fast-provider"
          value={fast}
          onChange={(next) => {
            setFast(next);
            clearMessage();
          }}
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
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save
        </Button>
      </SettingsActions>
    </div>
  );
}
