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

/**
 * Sent by the server right after token validation to challenge the remote to
 * prove it holds the stable machine private key. The remote must respond with
 * a MachineAuthFrame whose signature covers this nonce.
 */
export interface MachineChallengeFrame {
  type: "machine_challenge";
  /** base64-encoded random nonce, fresh per connection (anti-replay). */
  nonce: string;
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

/**
 * Remote's response to a MachineChallengeFrame. Carries the remote's stable
 * public key (used to identify the machine across remote_servers.id changes)
 * and an Ed25519 signature over the challenge nonce proving private-key
 * possession.
 */
export interface MachineAuthFrame {
  type: "machine_auth";
  /** SPKI PEM of the remote's stable machine public key. */
  publicKey: string;
  /** base64-encoded Ed25519 signature over the challenge nonce. */
  signature: string;
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
  | PingFrame
  | MachineChallengeFrame;

export type RemoteToServerFrame =
  | HttpResponseFrame
  | WsDataFrame
  | WsCloseFrame
  | PongFrame
  | StatusFrame
  | MachineAuthFrame;

export type ControlFrame = ServerToRemoteFrame | RemoteToServerFrame;
