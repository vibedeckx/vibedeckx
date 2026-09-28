import type { Dispatcher } from "undici";

/**
 * Provider-neutral text-to-speech contract. Everything vendor-specific (auth
 * headers, SSML, voice catalogues, error bodies) lives behind `TtsProviderDef`;
 * routes, config and the UI only ever see these shapes.
 * Design: docs/agent-message-tts-design.md.
 */

export interface TtsCredentialField {
  key: string;
  label: string;
  /** Masked on read; a masked value sent back on write means "unchanged". */
  secret: boolean;
  /** Env var consulted when no value is stored for this field. */
  envKey?: string;
  placeholder?: string;
}

export interface TtsVoice {
  id: string;
  label: string;
  locale?: string;
  /** Speaks several languages with one voice (auto-detected per sentence). */
  multilingual?: boolean;
  /**
   * Provider-defined section for the voice picker (e.g. "HD Omni",
   * "Multilingual"). The UI shows groups in the order they first appear.
   */
  group?: string;
}

export interface SynthesizeRequest {
  /** Plain text — the provider does its own escaping / SSML wrapping. */
  text: string;
  voice: string;
  // No speaking rate: speed is applied at playback (audio.playbackRate), which
  // works for every provider and voice — Azure's HD voices ignore SSML prosody.
  signal: AbortSignal;
  dispatcher?: Dispatcher;
}

export interface SynthesizeResult {
  audio: ReadableStream<Uint8Array>;
  contentType: string;
}

export interface ListVoicesOptions {
  signal: AbortSignal;
  dispatcher?: Dispatcher;
}

export type TtsCredentials = Record<string, string>;

export interface TtsProviderDef {
  id: string;
  label: string;
  credentialFields: readonly TtsCredentialField[];
  defaultVoice: string;
  /** Per-request text cap. The client chunks to it; the route rejects above it. */
  maxCharsPerRequest: number;
  /** Cheap syntactic check so a voice id never reaches the vendor unvalidated. */
  isValidVoice: (voice: string) => boolean;
  listVoices: (creds: TtsCredentials, opts: ListVoicesOptions) => Promise<TtsVoice[]>;
  synthesize: (creds: TtsCredentials, req: SynthesizeRequest) => Promise<SynthesizeResult>;
}

export type TtsErrorKind = "auth" | "quota" | "bad_request" | "upstream" | "network";

/** Normalized provider failure; routes map `kind` to an HTTP status. */
export class TtsProviderError extends Error {
  constructor(
    readonly kind: TtsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TtsProviderError";
  }
}
