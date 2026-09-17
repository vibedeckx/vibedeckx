"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DEFAULT_BUILDER,
  MINUTE_INTERVALS,
  buildCron,
  formatInZone,
  listTimezones,
  parseCron,
  type CronBuilder,
  type CronPreview,
  type Frequency,
} from "@/lib/schedule-cron";

const FREQUENCY_LABELS: Record<Frequency, string> = {
  minutes: "Every N minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom (cron)",
};

// Monday-first, values are cron day-of-week numbers.
const WEEKDAY_CHIPS: Array<[number, string]> = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"],
];

/**
 * Schedule timing: a frequency builder for the common shapes, a raw cron
 * editor for everything else, and a live preview in the schedule's timezone.
 * Controlled by `cronExpr` — the builder state is re-derived from it, so a
 * cron seeded after mount (edit dialog) lands in the right mode.
 */
export function ScheduleTimingField({
  cronExpr,
  onCronExprChange,
  timezone,
  onTimezoneChange,
  preview,
  disabled,
}: {
  cronExpr: string;
  onCronExprChange: (expr: string) => void;
  timezone: string;
  onTimezoneChange: (timezone: string) => void;
  preview: CronPreview;
  disabled?: boolean;
}) {
  const parsed = useMemo(() => parseCron(cronExpr), [cronExpr]);
  const [forceCustom, setForceCustom] = useState(false);
  // A cron that lands in custom stays there while it's edited: an intermediate
  // keystroke (e.g. "0 9-17 * * *" -> "0 9 * * *") must not swap out the input.
  if (!parsed && !forceCustom) setForceCustom(true);
  const frequency: Frequency = forceCustom || !parsed ? "custom" : parsed.frequency;
  const builder = parsed ?? DEFAULT_BUILDER;

  const update = (patch: Partial<CronBuilder>) => onCronExprChange(buildCron({ ...builder, ...patch }));

  const handleFrequency = (next: Frequency) => {
    if (next === "custom") {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    update({ frequency: next });
  };

  const toggleWeekday = (day: number) => {
    const has = builder.weekdays.includes(day);
    if (has && builder.weekdays.length === 1) return;
    update({ weekdays: has ? builder.weekdays.filter((d) => d !== day) : [...builder.weekdays, day] });
  };

  const timeInput = (
    <Input
      type="time"
      aria-label="Time"
      value={builder.time}
      onChange={(e) => { if (e.target.value) update({ time: e.target.value }); }}
      className="h-8"
      disabled={disabled}
    />
  );

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Schedule</label>
      <div className="grid grid-cols-2 gap-3">
        <Select value={frequency} onValueChange={(v) => handleFrequency(v as Frequency)} disabled={disabled}>
          <SelectTrigger size="sm" aria-label="Frequency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
              <SelectItem key={f} value={f}>{FREQUENCY_LABELS[f]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {frequency === "minutes" && (
          <Select value={String(builder.interval)} onValueChange={(v) => update({ interval: parseInt(v, 10) })} disabled={disabled}>
            <SelectTrigger size="sm" aria-label="Interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MINUTE_INTERVALS.map((n) => (
                <SelectItem key={n} value={String(n)}>every {n} minutes</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {frequency === "hourly" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="shrink-0">at minute</span>
            <Input
              type="number"
              aria-label="Minute"
              min={0}
              max={59}
              value={builder.minute}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isInteger(n) && n >= 0 && n <= 59) update({ minute: n });
              }}
              className="h-8 w-20"
              disabled={disabled}
            />
          </div>
        )}
        {(frequency === "daily" || frequency === "weekdays" || frequency === "weekly") && timeInput}
        {frequency === "monthly" && (
          <div className="flex items-center gap-2">
            <Select value={String(builder.dayOfMonth)} onValueChange={(v) => update({ dayOfMonth: parseInt(v, 10) })} disabled={disabled}>
              <SelectTrigger size="sm" aria-label="Day of month" className="w-20 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {timeInput}
          </div>
        )}
        {frequency === "custom" && (
          <Input
            value={cronExpr}
            onChange={(e) => onCronExprChange(e.target.value)}
            placeholder="0 9 * * 1-5"
            aria-label="Cron expression"
            className="h-8 font-mono"
            disabled={disabled}
          />
        )}
      </div>

      {frequency === "weekly" && (
        <div className="flex flex-wrap gap-1">
          {WEEKDAY_CHIPS.map(([day, label]) => {
            const on = builder.weekdays.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => toggleWeekday(day)}
                disabled={disabled}
                className={cn(
                  "h-7 rounded-md border px-2 text-xs transition-colors",
                  on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {frequency === "custom" && (
        <p className="text-xs text-muted-foreground">
          5-field cron: minute hour day-of-month month day-of-week
        </p>
      )}

      <div data-slot="schedule-preview" className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-1">
        {preview.ok ? (
          <>
            <div className="flex flex-wrap items-center gap-x-1.5">
              {preview.description && <span className="font-medium text-foreground">{preview.description}</span>}
              <TimezonePicker value={timezone} onChange={onTimezoneChange} disabled={disabled} />
            </div>
            <div className="text-muted-foreground">
              Next: {preview.nextRuns.length > 0
                ? preview.nextRuns.map((d) => formatInZone(d, timezone)).join(" · ")
                : "never"}
            </div>
            {frequency !== "custom" && (
              <div className="font-mono text-muted-foreground/70">{cronExpr}</div>
            )}
          </>
        ) : (
          <>
            <div className="text-destructive">{preview.error}</div>
            <TimezonePicker value={timezone} onChange={onTimezoneChange} disabled={disabled} />
          </>
        )}
      </div>
    </div>
  );
}

function TimezonePicker({ value, onChange, disabled }: { value: string; onChange: (tz: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => listTimezones(), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Timezone"
          disabled={disabled}
          className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          ({value})
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <Command>
          <CommandInput placeholder="Search timezone…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No timezone found</CommandEmpty>
            {zones.map((zone) => (
              <CommandItem
                key={zone}
                value={zone}
                onSelect={() => { onChange(zone); setOpen(false); }}
              >
                <Check className={cn("h-3.5 w-3.5", zone === value ? "opacity-100" : "opacity-0")} />
                {zone}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
