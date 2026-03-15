"use client";

import { ArrowRight, Sparkles, FolderKanban, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const features = [
  {
    icon: Sparkles,
    title: "AI-Powered Generation",
    description:
      "Generate full applications from natural language descriptions using state-of-the-art AI agents.",
  },
  {
    icon: FolderKanban,
    title: "Project Management",
    description:
      "Organize, track, and manage your AI-generated projects with built-in project management tools.",
  },
  {
    icon: Bot,
    title: "Multi-Agent Workflows",
    description:
      "Orchestrate multiple AI agents working together to build, test, and refine your applications.",
  },
];

export function LandingPage({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-center">
          Vibedeckx
        </h1>
        <p className="mt-4 text-lg sm:text-xl text-muted-foreground text-center max-w-xl">
          AI-Powered App Generator &amp; Project Management
        </p>
        <Button size="lg" className="mt-8 text-base" onClick={onSignIn}>
          Get Started
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
