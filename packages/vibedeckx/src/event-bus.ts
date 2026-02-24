import { EventEmitter } from "events";

// Event payload types
export type GlobalEvent =
  | { type: "session:status"; projectId: string; branch: string | null; sessionId: string; status: "running" | "stopped" | "error" }
  | { type: "session:finished"; projectId: string; branch: string | null; sessionId: string; duration_ms?: number; cost_usd?: number }
  | { type: "task:created"; projectId: string; task: Record<string, unknown> }
  | { type: "task:updated"; projectId: string; task: Record<string, unknown> }
  | { type: "task:deleted"; projectId: string; taskId: string }
  | { type: "executor:started"; projectId: string; executorId: string; processId: string }
  | { type: "executor:stopped"; projectId: string; executorId: string; processId: string; exitCode: number };

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: GlobalEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: GlobalEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}
