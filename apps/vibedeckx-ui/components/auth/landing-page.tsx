"use client";

import { useState } from "react";
import {
  ArrowRight,
  Gauge,
  Layers,
  Radio,
  Apple,
  Monitor,
  Terminal,
  Copy,
  Check,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";

const features = [
  {
    icon: Gauge,
    title: "Autopilot Mode",
    description:
      "Describe your idea and let AI agents take the wheel — from architecture to code, fully automated from launch to landing.",
  },
  {
    icon: Layers,
    title: "Mission Control",
    description:
      "A cockpit dashboard for every build task. Track progress in real time and stay in command of the entire operation.",
  },
  {
    icon: Radio,
    title: "Multi-Agent Fleet",
    description:
      "Deploy multiple AI agents in parallel — building, testing, and iterating simultaneously at autopilot speed.",
  },
];

type Platform = "macos" | "linux" | "windows";

const platforms: {
  id: Platform;
  label: string;
  icon: typeof Apple;
  steps: { text: string; command?: string }[];
}[] = [
  {
    id: "macos",
    label: "macOS",
    icon: Apple,
    steps: [
      {
        text: "1. Download the package from the release page",
      },
      {
        text: "2. Install globally via npm",
        command: "npm install -g ./vibedeckx-0.1.6-darwin-arm64.tar.gz",
      },
      {
        text: "3. Run",
        command: "vibedeckx",
      },
    ],
  },
  {
    id: "linux",
    label: "Linux",
    icon: Terminal,
    steps: [
      {
        text: "1. Download the package from the release page",
      },
      {
        text: "2. Run directly with npx",
        command: "npx -y ./vibedeckx-0.1.6-linux-x64.tar.gz",
      },
    ],
  },
  {
    id: "windows",
    label: "Windows",
    icon: Monitor,
    steps: [
      {
        text: "1. Download the package from the release page",
      },
      {
        text: "2. Run directly with npx",
        command: "npx -y ./vibedeckx-0.1.6-win-x64.tar.gz",
      },
    ],
  },
];

function CodeBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2 bg-background rounded-md border px-3 py-2 font-mono text-sm">
      <code className="flex-1 overflow-x-auto">{command}</code>
      <button
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Copy command"
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

export function LandingPage({ onSignIn }: { onSignIn: () => void }) {
  const [activePlatform, setActivePlatform] = useState<Platform>("macos");
  const activeConfig = platforms.find((p) => p.id === activePlatform)!;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-center">
          VibeDeckX
        </h1>
        <p className="mt-4 text-lg sm:text-xl text-muted-foreground text-center max-w-2xl">
          The Autopilot Cockpit for Building Apps with AI
        </p>
        <p className="mt-2 text-sm text-muted-foreground/70 text-center max-w-lg">
          Describe your vision. We handle the rest.
        </p>
        <Button size="lg" className="mt-8 text-base" onClick={onSignIn}>
          Enter the Cockpit
          <ArrowRight className="ml-2 h-5 w-5" />
        </Button>
      </div>

      {/* Feature cards */}
      <div className="px-4 pb-16 max-w-5xl mx-auto w-full">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {features.map((f) => (
            <Card key={f.title} className="bg-muted/40">
              <CardHeader>
                <f.icon className="h-8 w-8 text-primary mb-2" />
                <CardTitle>{f.title}</CardTitle>
                <CardDescription>{f.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>

      {/* Installation */}
      <div className="px-4 pb-20 max-w-3xl mx-auto w-full">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold tracking-tight">Get Started</h2>
          <p className="mt-2 text-muted-foreground">
            Download from the{" "}
            <a
              href="https://github.com/vibedeckx-dev/vibedeckx/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-foreground transition-colors"
            >
              latest release
              <Download className="inline h-4 w-4 ml-1" />
            </a>{" "}
            and install for your platform.
          </p>
        </div>

        {/* Platform tabs */}
        <div className="flex justify-center gap-2 mb-6">
          {platforms.map((p) => (
            <button
              key={p.id}
              onClick={() => setActivePlatform(p.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activePlatform === p.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              }`}
            >
              <p.icon className="h-4 w-4" />
              {p.label}
            </button>
          ))}
        </div>

        {/* Steps */}
        <Card className="bg-muted/40">
          <CardContent className="pt-6 space-y-4">
            {activeConfig.steps.map((step, i) => (
              <div key={i} className="space-y-2">
                <p className="text-sm text-muted-foreground">{step.text}</p>
                {step.command && <CodeBlock command={step.command} />}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
