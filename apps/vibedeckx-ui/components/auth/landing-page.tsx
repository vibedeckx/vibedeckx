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
    title: "自动驾驶模式",
    description:
      "描述你的想法，AI 代理全程接管——从架构设计到代码生成，一键启动，全程自动。",
  },
  {
    icon: Layers,
    title: "任务编排中心",
    description:
      "可视化管理每一个构建任务，实时追踪进度，像驾驶舱仪表盘一样掌控全局。",
  },
  {
    icon: Radio,
    title: "多代理协同",
    description:
      "多个 AI 代理并行工作、协同调度，自动完成构建、测试与迭代，效率倍增。",
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
          AI 应用构建的自动驾驶舱——描述想法，坐享其成
        </p>
        <p className="mt-2 text-sm text-muted-foreground/70 text-center max-w-lg">
          The Autopilot Cockpit for AI App Development
        </p>
        <Button size="lg" className="mt-8 text-base" onClick={onSignIn}>
          进入驾驶舱
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
