"use client";

import { UserButton } from "@clerk/clerk-react";
import { useAppConfig } from "@/hooks/use-app-config";

export function UserMenu() {
  const { config } = useAppConfig();

  if (!config?.authEnabled) return null;

  return (
    <div className="flex items-center justify-center py-2">
      <UserButton
        appearance={{
          elements: {
            avatarBox: "h-7 w-7",
          },
        }}
      />
    </div>
  );
}
