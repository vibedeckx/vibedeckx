"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type ProxyConfig } from "@/lib/api";
import {
  CheckCircle2,
  Loader2,
  Network,
  ShieldOff,
  Waypoints,
  XCircle,
} from "lucide-react";
import {
  RadioOption,
  SettingsActions,
  SettingsField,
  SettingsRadioCards,
  SettingsStatus,
} from "./settings-shell";

type ProxyType = ProxyConfig["type"];

const PROXY_OPTIONS: ReadonlyArray<RadioOption<ProxyType>> = [
  { value: "none", label: "Direct", description: "No proxy — connect directly to the internet", Icon: ShieldOff },
  { value: "http", label: "HTTP / HTTPS", description: "Route through an HTTP CONNECT proxy", Icon: Network },
  { value: "socks5", label: "SOCKS5", description: "Route through a SOCKS5 proxy server", Icon: Waypoints },
];

export function ProxySettings() {
  const [proxyType, setProxyType] = useState<ProxyType>("none");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string } | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setTestResult(null);
    setSaveMessage(null);
    api
      .getProxySettings()
      .then((config) => {
        setProxyType(config.type);
        setHost(config.host);
        setPort(config.port ? String(config.port) : "");
      })
      .finally(() => setLoading(false));
  }, []);

  const buildConfig = (): ProxyConfig => ({
    type: proxyType,
    host: proxyType === "none" ? "" : host.trim(),
    port: proxyType === "none" ? 0 : parseInt(port, 10) || 0,
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testProxyConnection(buildConfig()));
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage(null);
    try {
      await api.updateProxySettings(buildConfig());
      setSaveMessage("Settings saved");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const proxyEnabled = proxyType !== "none";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsField label="Connection mode">
        <SettingsRadioCards
          name="proxyType"
          value={proxyType}
          options={PROXY_OPTIONS}
          onChange={(v) => {
            setProxyType(v);
            setTestResult(null);
            setSaveMessage(null);
          }}
        />
      </SettingsField>

      {proxyEnabled && (
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <SettingsField label="Host" mono>
            <Input
              placeholder="127.0.0.1"
              value={host}
              className="font-mono text-[12.5px]"
              onChange={(e) => {
                setHost(e.target.value);
                setTestResult(null);
                setSaveMessage(null);
              }}
            />
          </SettingsField>
          <SettingsField label="Port" mono>
            <Input
              type="number"
              placeholder="1080"
              value={port}
              className="font-mono text-[12.5px]"
              onChange={(e) => {
                setPort(e.target.value);
                setTestResult(null);
                setSaveMessage(null);
              }}
              min={1}
              max={65535}
            />
          </SettingsField>
        </div>
      )}

      {testResult && (
        <SettingsStatus
          variant={testResult.success ? "success" : "error"}
          icon={
            testResult.success ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )
          }
        >
          {testResult.message ?? (testResult.success ? "Connection succeeded" : "Connection failed")}
        </SettingsStatus>
      )}

      {saveMessage && !testResult && (
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
        {proxyEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing || !host.trim() || !port}
          >
            {testing && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Test connection
          </Button>
        )}
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save changes
        </Button>
      </SettingsActions>
    </div>
  );
}
