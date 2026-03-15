'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type ProxyConfig } from '@/lib/api';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { RemoteServersSettings } from './remote-servers-settings';

type ProxyType = ProxyConfig['type'];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [proxyType, setProxyType] = useState<ProxyType>('none');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLoading(true);
      setTestResult(null);
      setSaveMessage(null);
      api.getProxySettings().then((config) => {
        setProxyType(config.type);
        setHost(config.host);
        setPort(config.port ? String(config.port) : '');
        setLoading(false);
      }).catch(() => {
        setLoading(false);
      });
    }
  }, [open]);

  const buildConfig = (): ProxyConfig => ({
    type: proxyType,
    host: proxyType === 'none' ? '' : host.trim(),
    port: proxyType === 'none' ? 0 : parseInt(port, 10) || 0,
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProxyConnection(buildConfig());
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await api.updateProxySettings(buildConfig());
      setSaveMessage('Settings saved');
      setTimeout(() => onOpenChange(false), 800);
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const proxyEnabled = proxyType !== 'none';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure application settings</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="remote-servers">
          <TabsList className="w-full">
            <TabsTrigger value="remote-servers" className="flex-1">Remote Servers</TabsTrigger>
            <TabsTrigger value="proxy" className="flex-1">Proxy</TabsTrigger>
          </TabsList>

          <TabsContent value="remote-servers">
            <RemoteServersSettings />
          </TabsContent>

          <TabsContent value="proxy">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">Proxy Type</label>
                  <div className="space-y-2">
                    {([
                      ['none', 'No Proxy', 'Direct connection'],
                      ['http', 'HTTP Proxy', 'Route through HTTP/HTTPS proxy'],
                      ['socks5', 'SOCKS5 Proxy', 'Route through SOCKS5 proxy'],
                    ] as const).map(([value, label, desc]) => (
                      <label
                        key={value}
                        className={`flex items-start gap-3 p-2.5 rounded-md border cursor-pointer transition-colors ${
                          proxyType === value
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-muted-foreground/30'
                        }`}
                      >
                        <input
                          type="radio"
                          name="proxyType"
                          value={value}
                          checked={proxyType === value}
                          onChange={() => {
                            setProxyType(value);
                            setTestResult(null);
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

                {proxyEnabled && (
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-sm font-medium mb-1 block">Host</label>
                      <Input
                        placeholder="127.0.0.1"
                        value={host}
                        onChange={(e) => {
                          setHost(e.target.value);
                          setTestResult(null);
                          setSaveMessage(null);
                        }}
                      />
                    </div>
                    <div className="w-24">
                      <label className="text-sm font-medium mb-1 block">Port</label>
                      <Input
                        type="number"
                        placeholder="1080"
                        value={port}
                        onChange={(e) => {
                          setPort(e.target.value);
                          setTestResult(null);
                          setSaveMessage(null);
                        }}
                        min={1}
                        max={65535}
                      />
                    </div>
                  </div>
                )}

                {testResult && (
                  <div className={`flex items-center gap-2 text-sm p-2 rounded-md ${
                    testResult.success
                      ? 'text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-950/30'
                      : 'text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-950/30'
                  }`}>
                    {testResult.success ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate">{testResult.message}</span>
                  </div>
                )}

                {saveMessage && !testResult && (
                  <div className="text-sm text-muted-foreground text-center">{saveMessage}</div>
                )}
              </div>
            )}

            <DialogFooter className="mt-4">
              {proxyEnabled && (
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing || !host.trim() || !port}
                >
                  {testing && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                  Test Connection
                </Button>
              )}
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
