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
    <div className="flex items-center gap-2 bg-muted/50 rounded-lg border border-border/60 px-3 py-2.5 font-mono text-xs">
      <code className="flex-1 overflow-x-auto text-foreground/80">{command}</code>
      <button
        onClick={handleCopy}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded-md hover:bg-accent"
        aria-label="Copy command"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
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
      {/* Nav */}
      <header className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-[10px] font-bold text-primary-foreground tracking-tighter">VD</span>
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">VibeDeckX</span>
        </div>
        <Button variant="outline" size="sm" onClick={onSignIn} className="text-xs">
          Sign In
        </Button>
      </header>

      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-20">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          AI-Powered Development
        </div>
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-center text-balance text-foreground">
          The Autopilot Cockpit
          <br />
          <span className="text-primary">for Building Apps</span>
        </h1>
        <p className="mt-4 text-base sm:text-lg text-muted-foreground text-center max-w-xl leading-relaxed text-pretty">
          Describe your vision. Deploy multiple AI agents in parallel. Watch your project come to life.
        </p>
        <div className="mt-8 flex items-center gap-3">
          <Button size="lg" onClick={onSignIn} className="shadow-md text-sm px-6">
            Enter the Cockpit
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Feature cards */}
      <div className="px-4 pb-20 max-w-5xl mx-auto w-full">
        <div className="text-center mb-10">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">How it works</h2>
          <p className="mt-2 text-sm text-muted-foreground">Three steps to AI-powered development</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <Card key={f.title} className="bg-card border-border/60 shadow-sm hover:shadow-md transition-shadow duration-200">
              <CardHeader className="pb-3">
                <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <CardTitle className="text-base">{f.title}</CardTitle>
                <CardDescription className="text-sm leading-relaxed">{f.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>

      {/* Installation */}
      <div className="px-4 pb-24 max-w-3xl mx-auto w-full">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Get Started</h2>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            Download from the{" "}
            <a
              href="https://github.com/vibedeckx-dev/vibedeckx/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 underline underline-offset-4 transition-colors"
            >
              latest release
              <Download className="inline h-3.5 w-3.5 ml-1" />
            </a>{" "}
            and install for your platform.
          </p>
        </div>

        {/* Platform tabs */}
        <div className="flex justify-center gap-1.5 mb-5">
          {platforms.map((p) => (
            <button
              key={p.id}
              onClick={() => setActivePlatform(p.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all duration-150 ${
                activePlatform === p.id
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              <p.icon className="h-3.5 w-3.5" />
              {p.label}
            </button>
          ))}
        </div>

        {/* Steps */}
        <Card className="bg-card border-border/60 shadow-sm">
          <CardContent className="pt-5 pb-5 space-y-4">
            {activeConfig.steps.map((step, i) => (
              <div key={i} className="space-y-2">
                <p className="text-sm text-muted-foreground">{step.text}</p>
                {step.command && <CodeBlock command={step.command} />}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Footer */}
      <footer className="border-t border-border/40 py-6 text-center">
        <p className="text-xs text-muted-foreground/60">VibeDeckX -- The AI Autopilot for Development</p>
      </footer>
    </div>
  );
}
