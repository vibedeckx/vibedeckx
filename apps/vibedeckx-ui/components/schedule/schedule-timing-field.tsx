"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, Clock, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
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
import { BOX_INPUT, CONTROL_TRIGGER, ControlBox, FieldLabel, HintLine } from "./schedule-form-chrome";

const FREQUENCY_LABELS: Record<Frequency, string> = {
  minutes: "Every N minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom (cron)",
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Monday-first, values are cron day-of-week numbers.
const WEEKDAY_CHIPS: Array<[number, string]> = [
  [1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"],
];

/**
 * "Mon, Wed, Fri" / "Mon–Fri" / "Every day" for the weekly picker's trigger.
 * Past three days the names no longer fit the trigger, and the preview below
 * spells the set out in full anyway, so they collapse to a count.
 */
function summarizeWeekdays(days: number[]): string {
  const on = WEEKDAY_CHIPS.filter(([d]) => days.includes(d));
  if (on.length === 7) return "Every day";
  if (on.length === 5 && on.every(([d]) => d >= 1 && d <= 5)) return "Mon–Fri";
  if (on.length > 3) return `${on.length} days a week`;
  return on.map(([, label]) => label).join(", ");
}

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

  // Plain "HH:MM" text rather than <input type="time">: the native control
  // follows the browser locale (12-hour "09:00 AM") while the preview and the
  // cron are 24-hour. Keystrokes stay in a draft until they form a valid time.
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const timeBox = (className?: string) => (
    <ControlBox disabled={disabled} invalid={timeDraft !== null} className={className}>
      <Clock />
      <input
        type="text"
        inputMode="numeric"
        aria-label="Time"
        placeholder="09:00"
        value={timeDraft ?? builder.time}
        onChange={(e) => {
          const next = e.target.value;
          if (TIME_RE.test(next)) {
            setTimeDraft(null);
            update({ time: next });
          } else {
            setTimeDraft(next);
          }
        }}
        onBlur={() => setTimeDraft(null)}
        className={cn(BOX_INPUT, "font-mono text-xs tracking-tight")}
        disabled={disabled}
      />
    </ControlBox>
  );

  return (
    <div className="flex min-w-0 flex-col gap-[7px]">
      <FieldLabel>Schedule</FieldLabel>
      <div className="grid min-w-0 grid-cols-2 gap-2.5">
        <Select value={frequency} onValueChange={(v) => handleFrequency(v as Frequency)} disabled={disabled}>
          <SelectTrigger size="sm" aria-label="Frequency" className={CONTROL_TRIGGER}>
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
            <SelectTrigger size="sm" aria-label="Interval" className={CONTROL_TRIGGER}>
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
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="shrink-0">at minute</span>
            <ControlBox disabled={disabled} className="w-[72px] shrink-0 px-2.5">
              <input
                type="number"
                aria-label="Minute"
                min={0}
                max={59}
                value={builder.minute}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isInteger(n) && n >= 0 && n <= 59) update({ minute: n });
                }}
                className={cn(BOX_INPUT, "font-mono text-xs")}
                disabled={disabled}
              />
            </ControlBox>
          </div>
        )}
        {(frequency === "daily" || frequency === "weekdays") && timeBox()}
        {frequency === "weekly" && (
          <div className="flex min-w-0 gap-2">
            <WeekdayPicker value={builder.weekdays} onToggle={toggleWeekday} disabled={disabled} />
            {timeBox("w-[84px] shrink-0 px-2")}
          </div>
        )}
        {frequency === "monthly" && (
          <div className="flex min-w-0 gap-2">
            <Select value={String(builder.dayOfMonth)} onValueChange={(v) => update({ dayOfMonth: parseInt(v, 10) })} disabled={disabled}>
              <SelectTrigger size="sm" aria-label="Day of month" className={cn(CONTROL_TRIGGER, "w-[64px] shrink-0")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <SelectItem key={d} value={String(d)}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {timeBox("flex-1")}
          </div>
        )}
        {frequency === "custom" && (
          <ControlBox disabled={disabled} invalid={!preview.ok}>
            <input
              value={cronExpr}
              onChange={(e) => onCronExprChange(e.target.value)}
              placeholder="0 9 * * 1-5"
              aria-label="Cron expression"
              aria-invalid={!preview.ok || undefined}
              spellCheck={false}
              className={cn(BOX_INPUT, "font-mono text-xs tracking-tight")}
              disabled={disabled}
            />
          </ControlBox>
        )}
      </div>

      {frequency === "custom" && (
        <HintLine>
          <code className="font-mono text-[10.5px] text-muted-foreground">minute hour day-of-month month day-of-week</code>
        </HintLine>
      )}

      <div
        data-slot="schedule-preview"
        className="flex min-w-0 flex-col gap-[3px] rounded-[9px] border border-border/60 bg-secondary px-2.5 py-2"
      >
        {preview.ok ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs font-medium">
              <span className={preview.description ? undefined : "font-mono"}>{preview.description ?? cronExpr}</span>
              <TimezonePicker value={timezone} onChange={onTimezoneChange} disabled={disabled} />
            </div>
            <div className="text-[11px] text-muted-foreground">
              Next:{" "}
              {preview.nextRuns.length > 0 ? (
                preview.nextRuns.map((d, i) => (
                  <span key={d.getTime()}>
                    {i > 0 && " · "}
                    <span className={i === 0 ? "font-medium text-secondary-foreground" : undefined}>
                      {formatInZone(d, timezone)}
                    </span>
                  </span>
                ))
              ) : (
                "never"
              )}
            </div>
            {frequency !== "custom" && (
              <div className="font-mono text-[10.5px] text-muted-foreground/70">{cronExpr}</div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <TriangleAlert className="size-3 shrink-0" />
              <span className="min-w-0">{preview.error}</span>
            </div>
            <div className="w-fit">
              <TimezonePicker value={timezone} onChange={onTimezoneChange} disabled={disabled} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Weekly: trigger shows the chosen days, chips live in a popover. */
function WeekdayPicker({
  value,
  onToggle,
  disabled,
}: {
  value: number[];
  onToggle: (day: number) => void;
  disabled?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Weekdays"
          disabled={disabled}
          className={cn(
            "flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[9px] border border-input bg-card px-2.5 text-left text-[12.5px] text-foreground transition-colors",
            "hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-accent focus-visible:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{summarizeWeekdays(value)}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="flex flex-wrap gap-[5px]">
          {WEEKDAY_CHIPS.map(([day, label]) => {
            const on = value.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(day)}
                className={cn(
                  "grid h-[26px] place-items-center rounded-[7px] border px-[9px] text-[11px] transition-colors",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
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
          className="inline-flex items-center gap-0.5 border-b border-dashed border-border text-[11.5px] font-normal text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
        >
          ({value})
          <ChevronDown className="size-2.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
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
