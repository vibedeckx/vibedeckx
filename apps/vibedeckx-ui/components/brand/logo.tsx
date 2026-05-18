import { cn } from "@/lib/utils";

interface LogoProps {
  size?: number;
  className?: string;
  live?: boolean;
  stripes?: "auto" | "off" | "one" | "two";
}

// Stacked Deck mark — two offset rounded squares (graphite back, indigo front)
// with an optional green live-session dot. Theme-aware via fill-foreground/fill-primary.
// See design spec: ≥25% clear space, min 14px (drop dot + stripes below 14px).
export function Logo({ size = 24, className, live = true, stripes = "auto" }: LogoProps) {
  const stripeMode =
    stripes !== "auto"
      ? stripes
      : size >= 48
        ? "two"
        : size >= 20
          ? "one"
          : "off";
  const showLive = live && size >= 14;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect x="10" y="22" width="36" height="36" rx="8" className="fill-foreground" />
      <rect x="20" y="10" width="36" height="36" rx="8" className="fill-primary" />
      {stripeMode !== "off" && (
        <rect x="26" y="20" width="22" height="3" rx="1.5" fill="white" fillOpacity="0.22" />
      )}
      {stripeMode === "two" && (
        <rect x="26" y="26" width="14" height="3" rx="1.5" fill="white" fillOpacity="0.22" />
      )}
      {showLive && (
        <>
          <circle cx="50" cy="14" r="5" className="fill-emerald-500" fillOpacity="0.25" />
          <circle cx="50" cy="14" r="3" className="fill-emerald-500" />
        </>
      )}
    </svg>
  );
}
