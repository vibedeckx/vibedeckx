"use client";

import { Toaster } from "sonner";
import { useTheme } from "@/hooks/use-theme";

// Sonner needs an explicit theme to stay in sync with our toggle; without it
// Sonner falls back to "light" and toasts read wrong on dark backgrounds.
export function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} />;
}
