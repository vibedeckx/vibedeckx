import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import WebSocket from "ws";
import { attachWsHeartbeat } from "./ws-heartbeat.js";

/** Minimal duck-typed stand-in for a live `ws` socket. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  pings = 0;
  sent: string[] = [];
  terminated = 0;

  ping() { this.pings++; }
  send(data: string) { this.sent.push(data); }
  terminate() { this.terminated++; this.readyState = WebSocket.CLOSED; }
}

const asSocket = (s: FakeSocket) => s as unknown as WebSocket;

describe("attachWsHeartbeat", () => {
  let socket: FakeSocket;
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    stop = attachWsHeartbeat(asSocket(socket), { label: "test", intervalMs: 1000 });
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("pings without sending any application frame by default", () => {
    // Opt-out would be unsafe: our stream clients treat an unrecognised frame
    // as a protocol error (Project Chat) or as stream content (executor logs).
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1000);
      socket.emit("pong");
    }
    expect(socket.pings).toBe(3);
    expect(socket.sent).toEqual([]);
  });

  it("sends a keepalive frame each interval when opted in", () => {
    stop();
    socket = new FakeSocket();
    stop = attachWsHeartbeat(asSocket(socket), { label: "test", intervalMs: 1000, keepalive: true });
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    expect(JSON.parse(socket.sent[0]!)).toHaveProperty("keepalive");
  });

  it("terminates the socket when a ping goes unanswered for two intervals", () => {
    vi.advanceTimersByTime(1000); // ping sent, awaiting pong
    expect(socket.terminated).toBe(0);
    vi.advanceTimersByTime(1000); // still no pong
    expect(socket.terminated).toBe(1);
  });

  it("keeps a socket that pongs", () => {
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      socket.emit("pong");
    }
    expect(socket.terminated).toBe(0);
    expect(socket.pings).toBe(5);
  });

  it("accepts any inbound frame as proof of life", () => {
    // A client that never pongs but keeps talking must not be reaped.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      socket.emit("message", "{}");
    }
    expect(socket.terminated).toBe(0);
  });

  it("stops pinging after cleanup", () => {
    vi.advanceTimersByTime(1000);
    const pingsAtCleanup = socket.pings;
    stop();
    vi.advanceTimersByTime(5000);
    expect(socket.pings).toBe(pingsAtCleanup);
    expect(socket.terminated).toBe(0);
  });

  it("is inert once the socket is no longer OPEN", () => {
    socket.readyState = WebSocket.CLOSED;
    vi.advanceTimersByTime(5000);
    expect(socket.pings).toBe(0);
    expect(socket.terminated).toBe(0);
  });

  it("cleanup is idempotent", () => {
    stop();
    expect(() => stop()).not.toThrow();
  });
});
