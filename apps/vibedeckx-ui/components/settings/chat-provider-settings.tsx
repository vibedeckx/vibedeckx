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
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  type ChatProviderConfig,
  type DeepSeekModel,
} from "@/lib/api";
import { CheckCircle2, Loader2, Sparkles, Waypoints, XCircle } from "lucide-react";
import {
  RadioOption,
  SettingsActions,
  SettingsField,
  SettingsRadioCards,
  SettingsStatus,
} from "./settings-shell";

type Provider = ChatProviderConfig["provider"];

const PROVIDER_OPTIONS: ReadonlyArray<RadioOption<Provider>> = [
  {
    value: "deepseek",
    label: "DeepSeek",
    description: "Direct API access — lowest latency",
    Icon: Sparkles,
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Aggregator routing — many models available",
    Icon: Waypoints,
  },
];

const DEEPSEEK_MODEL_LABELS: Record<DeepSeekModel, string> = {
  "deepseek-v4-flash": "DeepSeek V4 Flash — faster, lower cost",
  "deepseek-v4-pro": "DeepSeek V4 Pro — higher quality",
};

export function ChatProviderSettings() {
  const [provider, setProvider] = useState<Provider>("deepseek");
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [deepseekModel, setDeepseekModel] = useState<DeepSeekModel>(DEFAULT_DEEPSEEK_MODEL);
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [deepseekKeyDirty, setDeepseekKeyDirty] = useState(false);
  const [openrouterKeyDirty, setOpenrouterKeyDirty] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .getChatProviderSettings()
      .then((config) => {
        setProvider(config.provider);
        setDeepseekApiKey(config.deepseekApiKey);
        setDeepseekModel(config.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL);
        setOpenrouterApiKey(config.openrouterApiKey);
        setOpenrouterModel(config.openrouterModel);
        setDeepseekKeyDirty(false);
        setOpenrouterKeyDirty(false);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const payload: Partial<ChatProviderConfig> = {
        provider,
        deepseekModel,
        openrouterModel,
      };
      if (deepseekKeyDirty) payload.deepseekApiKey = deepseekApiKey;
      if (openrouterKeyDirty) payload.openrouterApiKey = openrouterApiKey;

      const updated = await api.updateChatProviderSettings(payload);
      setDeepseekApiKey(updated.deepseekApiKey);
      setOpenrouterApiKey(updated.openrouterApiKey);
      setDeepseekKeyDirty(false);
      setOpenrouterKeyDirty(false);
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
    <div className="space-y-4">
      <SettingsField label="Provider">
        <SettingsRadioCards
          name="chatProvider"
          value={provider}
          options={PROVIDER_OPTIONS}
          onChange={(v) => {
            setProvider(v);
            setSaveMessage(null);
          }}
          columns={2}
        />
      </SettingsField>

      {provider === "deepseek" && (
        <>
          <SettingsField
            label="DeepSeek API key"
            mono
            hint={
              <>
                Leave empty to fall back to the{" "}
                <code className="font-mono text-[10.5px] bg-muted/60 border border-border/60 rounded px-1 py-px">
                  DEEPSEEK_API_KEY
                </code>{" "}
                environment variable.
              </>
            }
          >
            <Input
              type="password"
              className="font-mono text-[12px]"
              placeholder={deepseekApiKey && !deepseekKeyDirty ? deepseekApiKey : "sk-..."}
              value={deepseekKeyDirty ? deepseekApiKey : ""}
              onChange={(e) => {
                setDeepseekApiKey(e.target.value);
                setDeepseekKeyDirty(true);
                setSaveMessage(null);
              }}
            />
          </SettingsField>
          <SettingsField label="Model">
            <Select
              value={deepseekModel}
              onValueChange={(value) => {
                setDeepseekModel(value as DeepSeekModel);
                setSaveMessage(null);
              }}
            >
              <SelectTrigger className="w-full font-mono text-[12.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEEPSEEK_MODELS.map((model) => (
                  <SelectItem key={model} value={model} className="font-mono text-[12.5px]">
                    {DEEPSEEK_MODEL_LABELS[model]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsField>
        </>
      )}

      {provider === "openrouter" && (
        <>
          <SettingsField
            label="OpenRouter API key"
            mono
            hint={
              <>
                Leave empty to fall back to the{" "}
                <code className="font-mono text-[10.5px] bg-muted/60 border border-border/60 rounded px-1 py-px">
                  OPENROUTER_API_KEY
                </code>{" "}
                environment variable.
              </>
            }
          >
            <Input
              type="password"
              className="font-mono text-[12px]"
              placeholder={openrouterApiKey && !openrouterKeyDirty ? openrouterApiKey : "sk-or-..."}
              value={openrouterKeyDirty ? openrouterApiKey : ""}
              onChange={(e) => {
                setOpenrouterApiKey(e.target.value);
                setOpenrouterKeyDirty(true);
                setSaveMessage(null);
              }}
            />
          </SettingsField>
          <SettingsField
            label="Model"
            mono
            hint="OpenRouter model identifier. Leave empty for default."
          >
            <Input
              className="font-mono text-[12.5px]"
              placeholder="deepseek/deepseek-chat-v3-0324"
              value={openrouterModel}
              onChange={(e) => {
                setOpenrouterModel(e.target.value);
                setSaveMessage(null);
              }}
            />
          </SettingsField>
        </>
      )}

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
          Save changes
        </Button>
      </SettingsActions>
    </div>
  );
}
