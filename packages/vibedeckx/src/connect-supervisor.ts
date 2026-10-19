import fs from "node:fs";
import path from "node:path";
import {
  PinMismatchError,
  PreflightAuthError,
  type PreflightResult,
} from "./connect-preflight.js";
import { TokenUnavailableError, type TokenSource } from "./connect-config.js";
import type { ConnectionState } from "./connect-heartbeat.js";

/**
 * Keeps a worker's hub connection alive through every recoverable failure
 * (worker-supervision-design §3.3) so a supervisor never sees a config problem
 * as a crash loop:
 *
 *  - network / hub errors  → `connecting`, exponential backoff with jitter;
 *  - token rejected        → `auth-failed`, slow retry that re-reads the token
 *                            (so recovery never depends on the file watcher);
 *  - pinned identity clash → `blocked`, no retries against the hub at all.
 *
 * Every new token goes through the identity preflight before it is used.
 */

export interface ConnectionClient {
  connect(): void;
  shutdown(): void;
}

export interface ConnectionClientCallbacks {
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onAuthRejected: (code: number, reason: string) => void;
}

export interface ConnectionSupervisorDeps {
  tokenSource: TokenSource;
  readToken: (source: TokenSource) => string;
  preflight: (token: string, force: boolean) => Promise<PreflightResult>;
  createClient: (token: string, callbacks: ConnectionClientCallbacks) => ConnectionClient;
  onState: (state: ConnectionState, detail?: string, fix?: string) => void;
  /** A pending `setup --force` re-pin. Consumed only by a successful preflight. */
  repinRequested?: () => boolean;
  clearRepinRequest?: () => void;
  /** --force on the command line: re-pin on every preflight of this run. */
  forceRepin?: boolean;
  /**
   * Fail start() on the first auth/pin error instead of waiting. Used when no
   * supervisor is restarting us (foreground / --daemon), where an immediate,
   * explicit error is the better experience.
   */
  failFast?: boolean;
  /** Watch a token file; returns an unsubscribe. Defaults to watchTokenFile. */
  watchToken?: (filePath: string, onChange: () => void) => () => void;
  log?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  authRetryMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export const AUTH_RETRY_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export const FIX_AUTH =
  "Get the current token from Settings → Remote Servers, then run `vibedeckx connect setup` " +
  "(or replace the token file). The worker picks it up automatically.";
export const FIX_PIN =
  "If this machine should now serve the token's remote, run `vibedeckx connect setup --force` " +
  "and then `vibedeckx connect restart`. Otherwise configure this machine's original token.";

export class ConnectionSupervisor {
  private client: ConnectionClient | null = null;
  private timer: unknown = null;
  private unwatch: (() => void) | null = null;
  private stopped = false;
  private attempt = 0;
  private attemptInFlight = false;
  private attemptQueued = false;
  private currentToken: string | undefined;
  private readonly d: Required<
    Pick<
      ConnectionSupervisorDeps,
      "log" | "setTimer" | "clearTimer" | "random" | "authRetryMs" | "backoffBaseMs" | "backoffMaxMs"
    >
  >;

  constructor(private readonly deps: ConnectionSupervisorDeps) {
    this.d = {
      log: deps.log ?? ((message) => console.log(message)),
      setTimer: deps.setTimer ?? ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      }),
      clearTimer: deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout)),
      random: deps.random ?? Math.random,
      authRetryMs: deps.authRetryMs ?? AUTH_RETRY_MS,
      backoffBaseMs: deps.backoffBaseMs ?? BACKOFF_BASE_MS,
      backoffMaxMs: deps.backoffMaxMs ?? BACKOFF_MAX_MS,
    };
  }

  /**
   * First attempt. Resolves once the tunnel client is dialing, or — when not
   * failing fast — once a recoverable failure has been recorded and a retry
   * scheduled. Rejects only with failFast on an auth/pin/token error.
   */
  async start(): Promise<void> {
    if (this.deps.tokenSource.kind === "file") {
      const watch = this.deps.watchToken ?? watchTokenFile;
      this.unwatch = watch(this.deps.tokenSource.path, () => this.onTokenFileChanged());
    }
    await this.runAttempt(this.deps.failFast ?? false);
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.unwatch?.();
    this.unwatch = null;
    this.client?.shutdown();
    this.client = null;
  }

  private clearRetry(): void {
    if (this.timer !== null) {
      this.d.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private scheduleRetry(ms: number): void {
    this.clearRetry();
    if (this.stopped) return;
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      void this.runAttempt(false);
    }, ms);
  }

  private backoffDelay(): number {
    const base = Math.min(
      this.d.backoffBaseMs * 2 ** this.attempt,
      this.d.backoffMaxMs,
    );
    this.attempt += 1;
    // Full jitter on top of half the base: many workers reconnecting after a
    // hub outage must not arrive in lockstep.
    return Math.round(base / 2 + (base / 2) * this.d.random());
  }

  private onTokenFileChanged(): void {
    if (this.stopped) return;
    let token: string;
    try {
      token = this.deps.readToken(this.deps.tokenSource);
    } catch {
      // Mid-replace or deleted: the periodic retry re-reads it later.
      return;
    }
    // Spurious events (other files, editors touching it) must not re-dial the
    // hub — least of all in `blocked`, which promises no retries.
    if (token === this.currentToken) return;
    this.d.log("[Connect] Token changed — re-verifying before reconnecting");
    void this.runAttempt(false);
  }

  /** Serialized: a token change during an attempt queues exactly one more. */
  private async runAttempt(failFast: boolean): Promise<void> {
    if (this.attemptInFlight) {
      this.attemptQueued = true;
      return;
    }
    this.attemptInFlight = true;
    try {
      await this.attemptOnce(failFast);
    } finally {
      this.attemptInFlight = false;
    }
    if (this.attemptQueued && !this.stopped) {
      this.attemptQueued = false;
      await this.runAttempt(false);
    }
  }

  private async attemptOnce(failFast: boolean): Promise<void> {
    if (this.stopped) return;
    this.clearRetry();

    let token: string;
    try {
      token = this.deps.readToken(this.deps.tokenSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dropClient();
      this.deps.onState("auth-failed", message, FIX_AUTH);
      if (failFast && error instanceof TokenUnavailableError) throw error;
      this.d.log(`[Connect] ${message}; waiting for a token`);
      this.scheduleRetry(this.d.authRetryMs);
      return;
    }

    const force = (this.deps.forceRepin ?? false) || (this.deps.repinRequested?.() ?? false);
    try {
      const result = await this.deps.preflight(token, force);
      if (this.stopped) return;
      if (force) this.deps.clearRepinRequest?.();
      if (result.checked && result.identity) {
        this.d.log(
          `[Connect] Remote identity verified: ${result.identity.name || result.identity.serverId}`,
        );
      }
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PinMismatchError) {
        this.dropClient();
        this.currentToken = token;
        this.deps.onState("blocked", message, FIX_PIN);
        if (failFast) throw error;
        // No timer: retrying the same token against the hub cannot help. A new
        // token (watcher) or a restart after `setup --force` can.
        this.d.log(`[Connect] Blocked: ${message}`);
        return;
      }
      if (error instanceof PreflightAuthError) {
        this.dropClient();
        this.currentToken = token;
        this.deps.onState("auth-failed", message, FIX_AUTH);
        if (failFast) throw error;
        this.d.log(`[Connect] ${message}; retrying in ${Math.round(this.d.authRetryMs / 1000)}s or when the token changes`);
        this.scheduleRetry(this.d.authRetryMs);
        return;
      }
      // Network / hub-side trouble: keep any live client, retry with backoff.
      if (!this.client) this.deps.onState("connecting", `Identity check failed: ${message}`);
      const delay = this.backoffDelay();
      this.d.log(`[Connect] Identity check failed (${message}); retrying in ${delay}ms`);
      this.scheduleRetry(delay);
      return;
    }

    this.attempt = 0;
    this.dropClient();
    this.currentToken = token;
    this.deps.onState("connecting");
    const client = this.deps.createClient(token, {
      onConnected: () => {
        if (this.client !== client) return;
        this.attempt = 0;
        this.deps.onState("connected");
      },
      onDisconnected: (reason) => {
        if (this.client !== client) return;
        this.deps.onState("connecting", `Disconnected: ${reason}`);
      },
      onAuthRejected: (code, reason) => {
        if (this.client !== client) return;
        this.client = null;
        const message =
          code === 4001
            ? "The hub rejected the connect token (invalid or revoked)"
            : "The hub refused this machine's identity";
        this.deps.onState("auth-failed", `${message} (${reason})`, FIX_AUTH);
        this.d.log(`[Connect] ${message}; retrying in ${Math.round(this.d.authRetryMs / 1000)}s or when the token changes`);
        this.scheduleRetry(this.d.authRetryMs);
      },
    });
    this.client = client;
    client.connect();
  }

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    client?.shutdown();
  }
}

/**
 * Watch a token file for replacement. Watches the containing directory, not
 * the file: an atomic replace (write temp + rename — how `setup` and Docker /
 * Kubernetes secrets update it) swaps the inode a file watch is bound to. A
 * lost watch is re-established; the supervisor's periodic re-read is the
 * backstop either way.
 */
export function watchTokenFile(
  filePath: string,
  onChange: () => void,
  options: { debounceMs?: number; rewatchMs?: number } = {},
): () => void {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const debounceMs = options.debounceMs ?? 200;
  const rewatchMs = options.rewatchMs ?? 60_000;
  let watcher: fs.FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let rewatch: NodeJS.Timeout | null = null;
  let closed = false;

  const fire = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!closed) onChange();
    }, debounceMs);
    debounce.unref?.();
  };

  const scheduleRewatch = (): void => {
    if (closed || rewatch) return;
    rewatch = setTimeout(() => {
      rewatch = null;
      establish(false);
    }, rewatchMs);
    rewatch.unref?.();
  };

  const establish = (initial: boolean): void => {
    if (closed) return;
    try {
      watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
        // Some platforms report no filename; treat that as a possible change.
        if (!name || name.toString() === basename) fire();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
        scheduleRewatch();
      });
      // After a lost watch, the file may have changed while we were blind.
      if (!initial) fire();
    } catch {
      watcher = null;
      scheduleRewatch();
    }
  };

  establish(true);
  return () => {
    closed = true;
    watcher?.close();
    watcher = null;
    if (debounce) clearTimeout(debounce);
    if (rewatch) clearTimeout(rewatch);
  };
}
