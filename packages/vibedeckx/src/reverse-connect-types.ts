/**
 * Frame types for the reverse connect WebSocket control channel protocol.
 *
 * The control channel carries multiplexed HTTP request/response pairs and
 * WebSocket sub-channels between the server and remote nodes.
 */

// ---------------------------------------------------------------------------
// Server → Remote frames
// ---------------------------------------------------------------------------

export interface HttpRequestFrame {
  type: "http_request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** When set, request targets localhost:{port} directly instead of the Fastify server */
  port?: number;
}

export interface WsOpenFrame {
  type: "ws_open";
  channelId: string;
  path: string;
  query?: string;
}

export interface PingFrame {
  type: "ping";
  ts: number;
}

// ---------------------------------------------------------------------------
// Remote → Server frames
// ---------------------------------------------------------------------------

export interface HttpResponseFrame {
  type: "http_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body?: string;
}

export interface PongFrame {
  type: "pong";
  ts: number;
}

export interface StatusFrame {
  type: "status";
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Bidirectional frames
// ---------------------------------------------------------------------------

export interface WsDataFrame {
  type: "ws_data";
  channelId: string;
  data: string;
}

export interface WsCloseFrame {
  type: "ws_close";
  channelId: string;
  code?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type ServerToRemoteFrame =
  | HttpRequestFrame
  | WsOpenFrame
  | WsDataFrame
  | WsCloseFrame
  | PingFrame;

export type RemoteToServerFrame =
  | HttpResponseFrame
  | WsDataFrame
  | WsCloseFrame
  | PongFrame
  | StatusFrame;

export type ControlFrame = ServerToRemoteFrame | RemoteToServerFrame;
