import { randomUUID } from "crypto";
import type { Dispatcher } from "undici";
import type { ProxyManager } from "./proxy-manager.js";

let globalProxyManager: ProxyManager | undefined;

export function setGlobalProxyManager(pm: ProxyManager): void {
  globalProxyManager = pm;
}

export interface ProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
  errorCode?: "timeout" | "network_error" | "auth_error" | "server_error" | "non_json_response";
  requestId?: string;
  durationMs?: number;
  /** Total number of attempts made (1 = no retries) */
  attempts?: number;
  /** Total wall-clock time including all retries */
  totalDurationMs?: number;
}

export interface ProxyOptions {
  requestId?: string;
  timeoutMs?: number;
  /** Optional undici dispatcher for proxy support */
  dispatcher?: Dispatcher;
}

const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;

function isTransientError(result: ProxyResult): boolean {
  return (
    result.errorCode === "network_error" ||
    result.errorCode === "non_json_response" ||
    TRANSIENT_STATUS_CODES.has(result.status)
  );
}

async function proxyOnce(
  baseUrl: string,
  apiKey: string,
  method: string,
  apiPath: string,
  body: unknown | undefined,
  requestId: string,
  timeoutMs: number,
  dispatcher?: Dispatcher,
): Promise<ProxyResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "X-Vibedeckx-Api-Key": apiKey,
      "X-Request-Id": requestId,
      "User-Agent": "Vibedeckx/1.0",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const effectiveDispatcher = dispatcher ?? globalProxyManager?.getFetchDispatcher();
    const fetchOptions: RequestInit & { dispatcher?: Dispatcher } = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };
    if (effectiveDispatcher) {
      fetchOptions.dispatcher = effectiveDispatcher;
    }
    const response = await fetch(`${baseUrl}${apiPath}`, fetchOptions as RequestInit);

    const durationMs = Date.now() - start;
    console.log(`[proxyToRemote] ${requestId} -> ${response.status} (${durationMs}ms)`);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      let errorCode: ProxyResult["errorCode"];
      if (!response.ok) {
        if (response.status === 401) errorCode = "auth_error";
        else if (response.status >= 500) errorCode = "server_error";
      }
      return { ok: response.ok, status: response.status, data, errorCode, requestId, durationMs };
    } else {
      const text = await response.text();
      const data = { error: `Non-JSON response (${response.status}): ${text.slice(0, 200)}` };
      return { ok: false, status: response.status, data, errorCode: "non_json_response", requestId, durationMs };
    }
  } catch (error) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : "Connection failed";
    console.error(`[proxyToRemote] ${requestId} FAILED: ${message} (${durationMs}ms)`);

    let errorCode: ProxyResult["errorCode"] = "network_error";
    if (error instanceof Error && error.name === "AbortError") {
      errorCode = "timeout";
    }

    return {
      ok: false,
      status: 0,
      data: { error: errorCode === "timeout" ? `Request timed out after ${timeoutMs}ms` : message },
      errorCode,
      requestId,
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function proxyToRemote(
  remoteUrl: string,
  apiKey: string,
  method: string,
  apiPath: string,
  body?: unknown,
  options?: ProxyOptions
): Promise<ProxyResult> {
  const requestId = options?.requestId ?? randomUUID();
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const baseUrl = remoteUrl.replace(/\/+$/, "");

  const totalStart = Date.now();
  console.log(`[proxyToRemote] ${requestId} ${method} ${baseUrl}${apiPath}`);

  let result = await proxyOnce(baseUrl, apiKey, method, apiPath, body, requestId, timeoutMs, options?.dispatcher);
  let attempts = 1;

  for (let attempt = 1; attempt <= MAX_RETRIES && isTransientError(result); attempt++) {
    const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
    console.log(
      `[proxyToRemote] ${requestId} retrying (${attempt}/${MAX_RETRIES}) after ${delay}ms...` +
      ` (last error: ${result.errorCode}, status: ${result.status})`
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
    result = await proxyOnce(baseUrl, apiKey, method, apiPath, body, requestId, timeoutMs, options?.dispatcher);
    attempts++;
  }

  const totalDurationMs = Date.now() - totalStart;
  result.attempts = attempts;
  result.totalDurationMs = totalDurationMs;

  if (!result.ok) {
    console.error(
      `[proxyToRemote] ${requestId} EXHAUSTED after ${attempts} attempt(s) in ${totalDurationMs}ms.` +
      ` Final error: ${result.errorCode}, status: ${result.status},` +
      ` data: ${JSON.stringify(result.data).substring(0, 300)}`
    );
  }

  return result;
}

export interface RawProxyResult {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

export async function proxyToRemoteRaw(
  remoteUrl: string,
  apiKey: string,
  apiPath: string,
  options?: { timeoutMs?: number; dispatcher?: Dispatcher }
): Promise<RawProxyResult> {
  const baseUrl = remoteUrl.replace(/\/+$/, "");
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const effectiveDispatcher = options?.dispatcher ?? globalProxyManager?.getFetchDispatcher();
    const fetchOptions: RequestInit & { dispatcher?: Dispatcher } = {
      method: "GET",
      headers: {
        "X-Vibedeckx-Api-Key": apiKey,
        "User-Agent": "Vibedeckx/1.0",
      },
      signal: controller.signal,
    };
    if (effectiveDispatcher) {
      fetchOptions.dispatcher = effectiveDispatcher;
    }
    const response = await fetch(`${baseUrl}${apiPath}`, fetchOptions as RequestInit);

    return { ok: response.ok, status: response.status, body: response.body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}
