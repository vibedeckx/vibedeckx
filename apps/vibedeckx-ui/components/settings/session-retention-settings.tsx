"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Infinity as InfinityIcon, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getSessionRetentionSettings,
  updateSessionRetentionSettings,
  type SessionRetentionSettings,
  type SessionRetentionWorkerResult,
} from "@/lib/api";
import {
  SettingsActions,
  SettingsField,
  SettingsRadioCards,
  SettingsStatus,
} from "./settings-shell";

type Mode = "off" | "on";

/**
 * Session retention. Off by default and never silently enabled: turning this
 * on starts permanently deleting conversation history, so the choice is always
 * the operator's. Favoriting a session exempts it — that is the only escape
 * hatch, deliberately, so there is one thing to remember rather than two.
 */
export function SessionRetentionSettingsSection() {
  const [limits, setLimits] = useState<SessionRetentionSettings | null>(null);
  const [mode, setMode] = useState<Mode>("off");
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [workers, setWorkers] = useState<SessionRetentionWorkerResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    getSessionRetentionSettings()
      .then((settings) => {
        if (cancelled) return;
        setLimits(settings);
        setMode(settings.days === null ? "off" : "on");
        setDays(String(settings.days ?? settings.suggestedDays));
      })
      .catch((error) => {
        if (cancelled) return;
        setMessage({ text: error instanceof Error ? error.message : "Failed to load settings", ok: false });
        // Render the form anyway so the operator isn't stuck on a spinner.
        setLimits({ days: null, suggestedDays: 90, minDays: 1, maxDays: 3650 });
      });
    return () => { cancelled = true; };
  }, []);

  if (!limits) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Number(), not parseInt(): parseInt("90.9") is 90, so the operator would be
  // told their input was fine and then silently have a different window saved.
  // Number() rejects it here, matching what the server would have rejected.
  const numericDays = days.trim() === "" ? NaN : Number(days);
  const daysValid =
    Number.isInteger(numericDays) && numericDays >= limits.minDays && numericDays <= limits.maxDays;
  const valid = mode === "off" || daysValid;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    setMessage(null);
    setWorkers([]);
    try {
      const saved = await updateSessionRetentionSettings(mode === "off" ? null : numericDays);
      setDays(String(saved.days ?? limits.suggestedDays));
      setWorkers(saved.workers);
      setMessage({
        text: saved.days === null
          ? "Retention is off — sessions are kept indefinitely"
          : `Sessions inactive for over ${saved.days} days will be deleted`,
        ok: true,
      });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Failed to save", ok: false });
    } finally {
      setSaving(false);
    }
  };

  const problemWorkers = workers.filter((w) => w.status !== "applied");

  return (
    <div className="space-y-4">
      <SettingsRadioCards<Mode>
        name="session-retention-mode"
        value={mode}
        columns={2}
        onChange={(next) => {
          setMode(next);
          setMessage(null);
          if (next === "on" && !days) setDays(String(limits.suggestedDays));
        }}
        options={[
          {
            value: "off",
            label: "Keep everything",
            description: "Sessions are never deleted automatically.",
            Icon: InfinityIcon,
            meta: "default",
          },
          {
            value: "on",
            label: "Delete old sessions",
            description: "Inactive, unfavorited sessions are removed.",
            Icon: CalendarClock,
          },
        ]}
      />

      {mode === "on" && (
        <SettingsField
          label="Keep for"
          mono
          hint={
            <span>
              Counted from a session&apos;s last activity, not its creation date. Favorited sessions
              and sessions in an active review are never deleted.{" "}
              <span className="font-mono text-foreground/70">
                {limits.minDays}–{limits.maxDays}
              </span>
              {" days · suggested "}
              <span className="font-mono text-foreground/70">{limits.suggestedDays}</span>
            </span>
          }
        >
          <div className="flex items-center gap-2 max-w-[220px]">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            <Input
              type="number"
              min={limits.minDays}
              max={limits.maxDays}
              value={days}
              className="font-mono text-[12.5px]"
              onChange={(event) => {
                setDays(event.target.value);
                setMessage(null);
              }}
            />
            <span className="text-[12px] text-muted-foreground">days</span>
          </div>
        </SettingsField>
      )}

      {message && (
        <SettingsStatus
          variant={message.ok ? "success" : "error"}
          icon={message.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        >
          {message.text}
        </SettingsStatus>
      )}

      {/* Workers that did not take the value. A worker predating this feature
          keeps its own sessions forever until it is updated — say so rather
          than letting the setting look global when it isn't yet. */}
      {problemWorkers.length > 0 && (
        <div className="space-y-1.5">
          {problemWorkers.map((worker) => (
            <SettingsStatus
              key={worker.remoteServerId}
              variant="default"
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
            >
              {worker.name}:{" "}
              {worker.status === "needs_upgrade"
                ? "update this worker to apply the retention window"
                : worker.status === "unreachable"
                  ? "offline — it will pick this up when it reconnects"
                  : worker.detail ?? "could not apply the retention window"}
            </SettingsStatus>
          ))}
        </div>
      )}

      <SettingsActions>
        <Button size="sm" onClick={handleSave} disabled={saving || !valid}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          Save
        </Button>
      </SettingsActions>
    </div>
  );
}
