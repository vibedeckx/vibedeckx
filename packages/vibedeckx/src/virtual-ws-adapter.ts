import { EventEmitter } from "events";

/**
 * A virtual WebSocket adapter that duck-types the WebSocket interface.
 * Used so that inbound remote connections can use the same code paths
 * as real WebSocket connections in websocket-routes.ts.
 */
export class VirtualWsAdapter extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  public readyState: number = VirtualWsAdapter.OPEN;

  private readonly sendFn: (data: string) => void;
  private readonly closeFn: () => void;

  constructor(sendFn: (data: string) => void, closeFn: () => void) {
    super();
    this.sendFn = sendFn;
    this.closeFn = closeFn;
  }

  /** Send data to the remote side via the provided callback. */
  send(data: string | Buffer): void {
    if (this.readyState !== VirtualWsAdapter.OPEN) return;
    const str = typeof data === "string" ? data : data.toString("utf-8");
    this.sendFn(str);
  }

  /** Close the virtual connection. */
  close(code?: number, reason?: string): void {
    if (this.readyState === VirtualWsAdapter.CLOSED) return;
    this.readyState = VirtualWsAdapter.CLOSED;
    this.closeFn();
    this.emit("close", code ?? 1000, reason ?? "");
  }

  /** No-op for virtual connections. */
  ping(): void {
    // no-op
  }

  /** Simulate receiving a message from the remote side. */
  deliverMessage(data: string): void {
    if (this.readyState !== VirtualWsAdapter.OPEN) return;
    this.emit("message", data);
  }

  /** Simulate the remote side closing the connection. */
  deliverClose(code?: number, reason?: string): void {
    if (this.readyState === VirtualWsAdapter.CLOSED) return;
    this.readyState = VirtualWsAdapter.CLOSED;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  /** Simulate an error on the connection. */
  deliverError(error: Error): void {
    this.emit("error", error);
  }
}
