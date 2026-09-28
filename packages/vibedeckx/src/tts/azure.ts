import type { Dispatcher } from "undici";
import {
  TtsProviderError,
  type TtsCredentials,
  type TtsProviderDef,
  type TtsVoice,
} from "./types.js";

/**
 * Azure Speech (REST). Default voice is a Multilingual neural voice: agent
 * replies mix Chinese and English, and these voices switch language per
 * sentence on their own, so we never have to detect language ourselves.
 */

const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const REGION_RE = /^[a-z0-9]+$/;
// Short names look like "zh-CN-XiaoxiaoMultilingualNeural"; HD voices add
// ":DragonHDLatestNeural".
const VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z0-9]{2,4}-[A-Za-z0-9:-]+$/;

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

/** 1.2 → "+20%", 0.9 → "-10%", 1 → null (no prosody wrapper). */
export function formatRate(rate: number): string | null {
  const pct = Math.round((rate - 1) * 100);
  if (pct === 0) return null;
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

export function buildSsml({ text, voice, rate }: { text: string; voice: string; rate: number }): string {
  const body = escapeXml(text);
  const pct = formatRate(rate);
  const inner = pct ? `<prosody rate="${pct}">${body}</prosody>` : body;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voiceLocale(voice)}">` +
    `<voice name="${escapeXml(voice)}">${inner}</voice></speak>`
  );
}

function regionOf(creds: TtsCredentials): string {
  const region = (creds.region ?? "").trim().toLowerCase();
  // The region is interpolated into a hostname — never let it carry dots,
  // slashes or ports.
  if (!REGION_RE.test(region)) throw new TtsProviderError("bad_request", "Invalid Azure region");
  return region;
}

function statusError(status: number): TtsProviderError {
  if (status === 401 || status === 403) return new TtsProviderError("auth", `Azure rejected the key (HTTP ${status})`);
  if (status === 429) return new TtsProviderError("quota", "Azure rate limit or quota exceeded");
  if (status === 400) return new TtsProviderError("bad_request", "Azure rejected the request (HTTP 400)");
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

export function mapAzureVoices(rows: AzureVoiceRow[]): TtsVoice[] {
  const voices: TtsVoice[] = [];
  for (const row of rows) {
    if (!row.ShortName || row.VoiceType !== "Neural") continue;
    const multilingual = /Multilingual/i.test(row.ShortName);
    voices.push({
      id: row.ShortName,
      label: `${row.LocalName || row.DisplayName || row.ShortName} (${row.Locale ?? voiceLocale(row.ShortName)})`,
      locale: row.Locale,
      multilingual,
    });
  }
  // Multilingual voices first — they are the sensible pick for mixed-language replies.
  voices.sort((a, b) => Number(!!b.multilingual) - Number(!!a.multilingual) || a.id.localeCompare(b.id));
  return voices;
}

export const azureProvider: TtsProviderDef = {
  id: "azure",
  label: "Azure Speech",
  credentialFields: [
    { key: "apiKey", label: "API key", secret: true, envKey: "AZURE_SPEECH_KEY" },
    { key: "region", label: "Region", secret: false, envKey: "AZURE_SPEECH_REGION", placeholder: "eastasia" },
  ],
  defaultVoice: "zh-CN-XiaoxiaoMultilingualNeural",
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

  async synthesize(creds, { text, voice, rate, signal, dispatcher }) {
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
        body: buildSsml({ text, voice, rate }),
        signal,
        dispatcher,
      },
    );
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw statusError(res.ok ? 502 : res.status);
    }
    return { audio: res.body, contentType: "audio/mpeg" };
  },
};
