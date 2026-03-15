"use client";

import { AuthWrapper } from "./auth-wrapper";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return <AuthWrapper>{children}</AuthWrapper>;
}
