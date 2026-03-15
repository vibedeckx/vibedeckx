"use client";

import {
  ArrowRight,
  Gauge,
  Layers,
  Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
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

export function LandingPage({ onSignIn }: { onSignIn: () => void }) {
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
    </div>
  );
}
