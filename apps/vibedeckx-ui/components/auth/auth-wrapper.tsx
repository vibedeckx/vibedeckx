"use client";

import { useEffect } from "react";
import { ClerkProvider, SignIn, useAuth } from "@clerk/clerk-react";
import { setAuthToken } from "@/lib/api";
import { useAppConfig } from "@/hooks/use-app-config";

function AuthTokenSync({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isSignedIn) {
      setAuthToken(null);
      return;
    }

    // Get initial token
    getToken().then((token) => setAuthToken(token));

    // Refresh token periodically (Clerk tokens expire ~60s)
    const interval = setInterval(async () => {
      const token = await getToken();
      setAuthToken(token);
    }, 50000);

    return () => clearInterval(interval);
  }, [isSignedIn, getToken]);

  return <>{children}</>;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="h-screen flex items-center justify-center bg-muted/40">
        <div className="w-full max-w-md">
          <SignIn
            routing="hash"
            appearance={{
              elements: {
                rootBox: "mx-auto",
                card: "shadow-lg",
              },
            }}
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function AuthWrapper({ children }: { children: React.ReactNode }) {
  const { config, loading } = useAppConfig();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // No auth mode — render children directly
  if (!config?.authEnabled || !config.clerkPublishableKey) {
    return <>{children}</>;
  }

  // Auth mode — wrap with ClerkProvider
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <AuthTokenSync>
        <AuthGate>{children}</AuthGate>
      </AuthTokenSync>
    </ClerkProvider>
  );
}
