"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AGENT_PROCESS_SETTINGS_LIMITS,
  DEFAULT_AGENT_PROCESS_SETTINGS,
  getAgentProcessSettings,
  updateAgentProcessSettings,
  type AgentProcessWorkerResult,
} from "@/lib/api";
import {
  SettingsActions,
  SettingsField,
  SettingsStatus,
} from "./settings-shell";

const { min, max } = AGENT_PROCESS_SETTINGS_LIMITS;

export function AgentProcessSettingsSection() {
  const [value, setValue] = useState(String(DEFAULT_AGENT_PROCESS_SETTINGS.maxResidentAgentProcesses));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [workers, setWorkers] = useState<AgentProcessWorkerResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    getAgentProcessSettings()
      .then((settings) => {
        if (cancelled) return;
        setValue(String(settings.maxResidentAgentProcesses));
        setLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setSaveMessage(error instanceof Error ? error.message : "Failed to load settings");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const numericValue = parseInt(value, 10);
  const valid = Number.isInteger(numericValue) && numericValue >= min && numericValue <= max;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    setSaveMessage(null);
    setWorkers([]);
    try {
      const saved = await updateAgentProcessSettings({
        maxResidentAgentProcesses: numericValue,
      });
      setValue(String(saved.maxResidentAgentProcesses));
      setWorkers(saved.workers ?? []);
      setSaveMessage("Settings saved");
      setTimeout(() => setSaveMessage(null), 2000);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const problemWorkers = workers.filter((w) => w.status !== "applied");

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsField
        label="Resident agent processes"
        mono
        hint={
          <span>
            Live agent processes per workspace, applied to all of your machines.{" "}
            <span className="font-mono text-foreground/70">{min}–{max}</span>
            {" · default "}
            <span className="font-mono text-foreground/70">
              {DEFAULT_AGENT_PROCESS_SETTINGS.maxResidentAgentProcesses}
            </span>
          </span>
        }
      >
        <div className="flex items-center gap-2 max-w-[220px]">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <Input
            type="number"
            min={min}
            max={max}
            value={value}
            className="font-mono text-[12.5px]"
            onChange={(event) => {
              setValue(event.target.value);
              setSaveMessage(null);
            }}
          />
        </div>
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

      {/* Machines that did not take the value. The limit is enforced on each
          machine, so say which ones still run the old one and whether the
          user has to act: an offline machine gets it on reconnect, a failed
          one only if the user saves again — nothing retries in the background. */}
      {problemWorkers.length > 0 && (
        <div className="space-y-1.5">
          {problemWorkers.map((worker) => (
            <SettingsStatus
              key={worker.remoteServerId}
              variant="default"
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
            >
              {worker.name}:{" "}
              {worker.status === "offline"
                ? "offline — it will pick this up when it reconnects"
                : `not applied (${worker.detail ?? "failed"}) — save again later to retry`}
            </SettingsStatus>
          ))}
        </div>
      )}

      <SettingsActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setValue(String(DEFAULT_AGENT_PROCESS_SETTINGS.maxResidentAgentProcesses));
            setSaveMessage(null);
          }}
          disabled={saving}
        >
          Reset
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving || !valid}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save
        </Button>
      </SettingsActions>
    </div>
  );
}
