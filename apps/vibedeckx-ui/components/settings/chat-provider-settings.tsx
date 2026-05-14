'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  api,
  DEEPSEEK_MODELS,
  DEFAULT_DEEPSEEK_MODEL,
  type ChatProviderConfig,
  type DeepSeekModel,
} from '@/lib/api';
import { Loader2, CheckCircle2 } from 'lucide-react';

type Provider = ChatProviderConfig['provider'];

const DEEPSEEK_MODEL_LABELS: Record<DeepSeekModel, string> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash — faster, lower cost',
  'deepseek-v4-pro': 'DeepSeek V4 Pro — higher quality',
};

export function ChatProviderSettings() {
  const [provider, setProvider] = useState<Provider>('deepseek');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [deepseekModel, setDeepseekModel] = useState<DeepSeekModel>(DEFAULT_DEEPSEEK_MODEL);
  const [openrouterApiKey, setOpenrouterApiKey] = useState('');
  const [openrouterModel, setOpenrouterModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // Track whether user has typed new keys (to avoid sending masked values)
  const [deepseekKeyDirty, setDeepseekKeyDirty] = useState(false);
  const [openrouterKeyDirty, setOpenrouterKeyDirty] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getChatProviderSettings().then((config) => {
      setProvider(config.provider);
      setDeepseekApiKey(config.deepseekApiKey);
      setDeepseekModel(config.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL);
      setOpenrouterApiKey(config.openrouterApiKey);
      setOpenrouterModel(config.openrouterModel);
      setDeepseekKeyDirty(false);
      setOpenrouterKeyDirty(false);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
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
      setSaveMessage('Settings saved');
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium mb-2 block">Provider</label>
        <div className="space-y-2">
          {([
            ['deepseek', 'DeepSeek', 'Use DeepSeek API directly'],
            ['openrouter', 'OpenRouter', 'Route through OpenRouter (supports many models)'],
          ] as const).map(([value, label, desc]) => (
            <label
              key={value}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-150 ${
                provider === value
                  ? 'border-primary/40 bg-primary/5 shadow-sm'
                  : 'border-border/60 hover:border-border hover:bg-accent/30'
              }`}
            >
              <input
                type="radio"
                name="chatProvider"
                value={value}
                checked={provider === value}
                onChange={() => {
                  setProvider(value);
                  setSaveMessage(null);
                }}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {provider === 'deepseek' && (
        <>
          <div>
            <label className="text-sm font-medium mb-1 block">DeepSeek API Key</label>
            <Input
              type="password"
              placeholder={deepseekApiKey && !deepseekKeyDirty ? deepseekApiKey : 'sk-...'}
              value={deepseekKeyDirty ? deepseekApiKey : ''}
              onChange={(e) => {
                setDeepseekApiKey(e.target.value);
                setDeepseekKeyDirty(true);
                setSaveMessage(null);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to use DEEPSEEK_API_KEY environment variable
            </p>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Model</label>
            <Select
              value={deepseekModel}
              onValueChange={(value) => {
                setDeepseekModel(value as DeepSeekModel);
                setSaveMessage(null);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEEPSEEK_MODELS.map((model) => (
                  <SelectItem key={model} value={model}>
                    {DEEPSEEK_MODEL_LABELS[model]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {provider === 'openrouter' && (
        <>
          <div>
            <label className="text-sm font-medium mb-1 block">OpenRouter API Key</label>
            <Input
              type="password"
              placeholder={openrouterApiKey && !openrouterKeyDirty ? openrouterApiKey : 'sk-or-...'}
              value={openrouterKeyDirty ? openrouterApiKey : ''}
              onChange={(e) => {
                setOpenrouterApiKey(e.target.value);
                setOpenrouterKeyDirty(true);
                setSaveMessage(null);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Leave empty to use OPENROUTER_API_KEY environment variable
            </p>
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Model</label>
            <Input
              placeholder="deepseek/deepseek-chat-v3-0324"
              value={openrouterModel}
              onChange={(e) => {
                setOpenrouterModel(e.target.value);
                setSaveMessage(null);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              OpenRouter model identifier. Leave empty for default.
            </p>
          </div>
        </>
      )}

      {saveMessage && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {saveMessage === 'Settings saved' && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {saveMessage}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
