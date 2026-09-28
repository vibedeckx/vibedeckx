import type { Dispatcher } from "undici";
import {
  TtsProviderError,
  type TtsCredentials,
  type TtsProviderDef,
  type TtsVoice,
} from "./types.js";

/**
 * Azure Speech (REST). The default voice is Dragon HD Omni: every Omni voice
 * is multilingual, so mixed Chinese/English replies need no language
 * detection on our side. Omni (like all HD voices) is only offered in some
 * regions, and it does not support <prosody> — speed is applied at playback.
 */

const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const REGION_RE = /^[a-z0-9]+$/;
// Short names look like "zh-CN-XiaoxiaoMultilingualNeural"; HD voices are
// "<persona>:<base model>", e.g. "zh-CN-Xiaoxiao:DragonHDOmniLatestNeural",
// and some personas carry dialect segments or underscores
// ("zh-cn-guangxi-yunqi:…", "zh-cn-yunze_customer:…").
const VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,4}-[A-Za-z0-9_:-]+$/;

/** Dragon HD family (DragonHD, DragonHDFlash, DragonHDOmni). */
export function isHdVoice(voice: string): boolean {
  return /:DragonHD/i.test(voice);
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "zh-CN-XiaoxiaoMultilingualNeural" → "zh-CN". */
export function voiceLocale(voice: string): string {
  const [lang, region] = voice.split("-");
  return lang && region ? `${lang}-${region}` : "en-US";
}

export function buildSsml({ text, voice }: { text: string; voice: string }): string {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceLocale(voice)}">` +
    `<voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`
  );
}

function regionOf(creds: TtsCredentials): string {
  const region = (creds.region ?? "").trim().toLowerCase();
  // The region is interpolated into a hostname — never let it carry dots,
  // slashes or ports.
  if (!REGION_RE.test(region)) throw new TtsProviderError("bad_request", "Invalid Azure region");
  return region;
}

function statusError(status: number, voice?: string): TtsProviderError {
  if (status === 401 || status === 403) return new TtsProviderError("auth", `Azure rejected the key (HTTP ${status})`);
  if (status === 429) return new TtsProviderError("quota", "Azure rate limit or quota exceeded");
  if (status === 400) {
    // The usual cause for an HD voice is a region without HD support. We
    // don't hard-code Azure's region list (it changes); we just say so.
    const hint = voice && isHdVoice(voice)
      ? " HD voices are only available in some Azure regions — check your resource's region, or pick a non-HD voice."
      : "";
    return new TtsProviderError("bad_request", `Azure rejected the request (HTTP 400).${hint}`);
  }
  return new TtsProviderError("upstream", `Azure returned HTTP ${status}`);
}

async function azureFetch(
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher },
): Promise<Response> {
  try {
    return await fetch(url, init as RequestInit);
  } catch (err) {
    // Cancellation and timeouts pass through untouched: the route tells a
    // client that went away (no reply) from a slow upstream (504).
    const name = (err as Error)?.name;
    if (name === "AbortError" || name === "TimeoutError") throw err;
    throw new TtsProviderError("network", `Could not reach Azure: ${(err as Error)?.message ?? err}`);
  }
}

interface AzureVoiceRow {
  ShortName?: string;
  LocalName?: string;
  DisplayName?: string;
  Locale?: string;
  VoiceType?: string;
}

const OMNI_GROUP = "HD Omni (recommended)";
const MULTILINGUAL_GROUP = "Multilingual";

/**
 * Only voices that speak every language on their own: Dragon HD Omni (all of
 * them are multilingual) and the neural "…MultilingualNeural" voices. Agent
 * replies mix languages, and a single-language voice would force users (this
 * runs as SaaS) to pick a voice per language. Plain Dragon HD (~30 personas,
 * covered by Omni) and single-language neural voices are left out; a user can
 * still type any voice ID by hand.
 */
export function mapAzureVoices(rows: AzureVoiceRow[]): TtsVoice[] {
  const voices: TtsVoice[] = [];
  for (const row of rows) {
    const id = row.ShortName;
    if (!id) continue;
    // Omni is kept whatever VoiceType the list reports for it.
    const omni = /:DragonHDOmni/i.test(id);
    const multilingual = !isHdVoice(id) && row.VoiceType === "Neural" && /Multilingual/i.test(id);
    if (!omni && !multilingual) continue;
    voices.push({
      id,
      label: `${row.LocalName || row.DisplayName || id} (${row.Locale ?? voiceLocale(id)})`,
      locale: row.Locale,
      multilingual: true,
      group: omni ? OMNI_GROUP : MULTILINGUAL_GROUP,
    });
  }
  // Omni first; the UI shows groups in the order they appear.
  voices.sort((a, b) => Number(b.group === OMNI_GROUP) - Number(a.group === OMNI_GROUP) || a.id.localeCompare(b.id));
  return voices;
}

export const azureProvider: TtsProviderDef = {
  id: "azure",
  label: "Azure Speech",
  credentialFields: [
    { key: "apiKey", label: "API key", secret: true, envKey: "AZURE_SPEECH_KEY" },
    { key: "region", label: "Region", secret: false, envKey: "AZURE_SPEECH_REGION", placeholder: "southeastasia" },
  ],
  defaultVoice: "zh-CN-Xiaoxiao:DragonHDOmniLatestNeural",
  maxCharsPerRequest: 1500,
  isValidVoice: (voice) => VOICE_RE.test(voice),

  async listVoices(creds, { signal, dispatcher }) {
    const res = await azureFetch(
      `https://${regionOf(creds)}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
      { headers: { "Ocp-Apim-Subscription-Key": creds.apiKey ?? "" }, signal, dispatcher },
    );
    if (!res.ok) throw statusError(res.status);
    const rows = (await res.json()) as unknown;
    return mapAzureVoices(Array.isArray(rows) ? (rows as AzureVoiceRow[]) : []);
  },

  async synthesize(creds, { text, voice, signal, dispatcher }) {
    const res = await azureFetch(
      `https://${regionOf(creds)}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": creds.apiKey ?? "",
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
          "User-Agent": "vibedeckx",
        },
        body: buildSsml({ text, voice }),
        signal,
        dispatcher,
      },
    );
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw statusError(res.ok ? 502 : res.status, voice);
    }
    return { audio: res.body, contentType: "audio/mpeg" };
  },
};
