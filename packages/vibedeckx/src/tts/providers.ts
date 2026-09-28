import { azureProvider } from "./azure.js";
import type { TtsProviderDef } from "./types.js";

/**
 * TTS provider registry — adding a provider = one entry here (and in
 * `TtsProviderId`). Nothing outside `src/tts/` knows any vendor by name.
 */
export type TtsProviderId = "azure";

export const TTS_PROVIDERS: Record<TtsProviderId, TtsProviderDef> = {
  azure: azureProvider,
};

export const TTS_PROVIDER_IDS = Object.keys(TTS_PROVIDERS) as TtsProviderId[];

export const DEFAULT_TTS_PROVIDER: TtsProviderId = "azure";

export function isTtsProviderId(value: unknown): value is TtsProviderId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TTS_PROVIDERS, value);
}
