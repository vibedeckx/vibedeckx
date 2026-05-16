"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/hooks/use-theme";

const OPTIONS: { value: Theme; label: string; description: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", description: "Always use the light theme", Icon: Sun },
  { value: "dark", label: "Dark", description: "Always use the dark theme", Icon: Moon },
  { value: "system", label: "System", description: "Match your operating system preference", Icon: Monitor },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div>
      <label className="text-sm font-medium mb-2 block">Theme</label>
      <div className="space-y-2">
        {OPTIONS.map(({ value, label, description, Icon }) => {
          const selected = theme === value;
          return (
            <label
              key={value}
              className={cn(
                "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all duration-150",
                selected
                  ? "border-primary/40 bg-primary/5 shadow-sm"
                  : "border-border/60 hover:border-border hover:bg-muted/40",
              )}
            >
              <input
                type="radio"
                name="theme"
                value={value}
                checked={selected}
                onChange={() => setTheme(value)}
                className="mt-0.5"
              />
              <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
              <div>
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
