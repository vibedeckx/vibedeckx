"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Section primitives implementing the design's `meta-section-title` /
// `sidebar-label` / `col-head` aesthetic — uppercase 10.5px, 0.06em tracking,
// muted color, hairline divider above the body.

interface SettingsSectionProps {
  id: string;
  label: string;
  description?: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsSection({
  id,
  label,
  description,
  rightSlot,
  children,
}: SettingsSectionProps) {
  return (
    <section id={id} className="scroll-mt-6">
      <header className="flex items-end justify-between gap-3 pb-3 mb-4 border-b border-border/70">
        <div className="min-w-0">
          <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80 leading-none">
            {label}
          </h2>
          {description && (
            <p className="mt-2 text-[12px] text-muted-foreground/90 leading-snug">
              {description}
            </p>
          )}
        </div>
        {rightSlot && <div className="shrink-0">{rightSlot}</div>}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

interface SettingsFieldProps {
  label: string;
  hint?: React.ReactNode;
  htmlFor?: string;
  mono?: boolean;
  children: React.ReactNode;
}

export function SettingsField({
  label,
  hint,
  htmlFor,
  mono,
  children,
}: SettingsFieldProps) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className={cn(
          "block text-[12px] font-medium text-foreground/90 mb-1.5",
          mono && "font-mono tracking-tight",
        )}
      >
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1.5 text-[11px] text-muted-foreground/85 leading-relaxed">
          {hint}
        </p>
      )}
    </div>
  );
}

// A radio-card group that matches the design language: hairline border,
// surface-2 background, accent-tint highlight on selection, optional left
// icon and a small "key" caption (mono) on the right for technical context.

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  Icon?: React.ComponentType<{ className?: string }>;
  meta?: string;
}

interface SettingsRadioCardsProps<T extends string> {
  name: string;
  value: T;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (value: T) => void;
  columns?: 1 | 2 | 3;
}

export function SettingsRadioCards<T extends string>({
  name,
  value,
  options,
  onChange,
  columns = 1,
}: SettingsRadioCardsProps<T>) {
  return (
    <div
      className={cn(
        "grid gap-2",
        columns === 1 && "grid-cols-1",
        columns === 2 && "grid-cols-1 sm:grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-3",
      )}
      role="radiogroup"
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        const Icon = opt.Icon;
        return (
          <label
            key={opt.value}
            className={cn(
              "group relative flex items-start gap-3 px-3 py-2.5 rounded-[8px] border cursor-pointer",
              "transition-[border-color,background-color,box-shadow] duration-150",
              "focus-within:ring-2 focus-within:ring-ring/40 focus-within:ring-offset-1 focus-within:ring-offset-background",
              selected
                ? "border-primary/40 bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))] shadow-[var(--shadow-sm-app)]"
                : "border-border/70 bg-card hover:border-border hover:bg-muted/40",
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={selected}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <span
              aria-hidden
              className={cn(
                "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                selected
                  ? "border-primary bg-primary"
                  : "border-border bg-card group-hover:border-foreground/40",
              )}
            >
              {selected && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
              )}
            </span>
            {Icon && (
              <Icon
                className={cn(
                  "h-4 w-4 mt-0.5 shrink-0 transition-colors",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
              />
            )}
            <span className="flex-1 min-w-0">
              <span
                className={cn(
                  "block text-[12.5px] font-medium leading-tight",
                  selected ? "text-foreground" : "text-foreground/90",
                )}
              >
                {opt.label}
              </span>
              {opt.description && (
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground leading-snug">
                  {opt.description}
                </span>
              )}
            </span>
            {opt.meta && (
              <span className="ml-2 mt-0.5 shrink-0 font-mono text-[10.5px] text-muted-foreground/80">
                {opt.meta}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

// Status row used at the bottom of each section to surface inline save/test
// feedback with an icon. Variant controls the color treatment (default /
// success / error) — we lean on the design's status-pill colors.
interface SettingsStatusProps {
  variant?: "default" | "success" | "error";
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export function SettingsStatus({
  variant = "default",
  icon,
  children,
}: SettingsStatusProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-[12px]",
        variant === "default" && "text-muted-foreground bg-muted/40",
        variant === "success" &&
          "text-[color:var(--chart-2)] bg-[color-mix(in_oklch,var(--chart-2)_10%,var(--card))] border border-[color-mix(in_oklch,var(--chart-2)_25%,transparent)]",
        variant === "error" &&
          "text-destructive bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))] border border-[color-mix(in_oklch,var(--destructive)_25%,transparent)]",
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{children}</span>
    </div>
  );
}

// Action footer — a hairline-bordered row that aligns Save / Test buttons
// with the rest of the section content.
export function SettingsActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">{children}</div>
  );
}

// ── Layout shell with section nav ───────────────────────────────────────────
// Two-column layout: a narrow sticky nav on the left listing sections, and
// the scrollable content on the right. Active section is determined by an
// IntersectionObserver scrollspy so the nav stays in sync without manual
// state plumbing from each section.

export interface SettingsNavItem {
  id: string;
  label: string;
  Icon?: React.ComponentType<{ className?: string }>;
  badge?: string;
}

interface SettingsLayoutProps {
  nav: SettingsNavItem[];
  children: React.ReactNode;
}

export function SettingsLayout({ nav, children }: SettingsLayoutProps) {
  const [active, setActive] = useState<string>(nav[0]?.id ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scrollspy: pick the first section whose top crosses a 25% viewport line.
  // Plain getBoundingClientRect on every scroll keeps this dependency-free
  // and works inside the inner scroller rather than against the document.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = () => {
      const rootRect = root.getBoundingClientRect();
      const probe = rootRect.top + rootRect.height * 0.25;
      let current = nav[0]?.id ?? "";
      for (const item of nav) {
        const el = root.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= probe) current = item.id;
      }
      setActive(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [nav]);

  const goTo = (id: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    const top = el.offsetTop - 12;
    root.scrollTo({ top, behavior: "smooth" });
    setActive(id);
  };

  return (
    <div className="flex-1 min-h-0 grid grid-cols-[200px_minmax(0,1fr)] overflow-hidden">
      <aside className="border-r border-border bg-[color:var(--sidebar)] overflow-y-auto">
        <nav className="p-3 flex flex-col gap-0.5">
          {nav.map((item) => {
            const Icon = item.Icon;
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => goTo(item.id)}
                className={cn(
                  "group relative flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-[6px] text-[12.5px] text-left",
                  "transition-colors duration-100",
                  isActive
                    ? "bg-card text-foreground font-medium shadow-[var(--shadow-sm-app)]"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute -left-3 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary"
                  />
                )}
                {Icon && (
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      isActive ? "text-foreground" : "text-muted-foreground/80",
                    )}
                  />
                )}
                <span className="truncate">{item.label}</span>
                {item.badge && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/80">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>
      <div ref={scrollRef} className="overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 py-7 space-y-12">{children}</div>
      </div>
    </div>
  );
}
