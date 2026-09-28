import { describe, it, expect, afterEach, vi } from "vitest";
import { azureProvider, buildSsml, isHdVoice, mapAzureVoices, voiceLocale } from "./azure.js";
import { TtsProviderError } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

const creds = { apiKey: "k-123", region: "eastasia" };
const signal = () => new AbortController().signal;

describe("azure SSML", () => {
  it("escapes text and voice, sets locale from the voice", () => {
    const ssml = buildSsml({ text: `a < b && "c" 'd' > e`, voice: "zh-CN-XiaoxiaoMultilingualNeural" });
    expect(ssml).toContain('xml:lang="zh-CN"');
    expect(ssml).toContain('<voice name="zh-CN-XiaoxiaoMultilingualNeural">');
    expect(ssml).toContain("a &lt; b &amp;&amp; &quot;c&quot; &apos;d&apos; &gt; e");
    expect(ssml).not.toContain("<prosody");
  });

  it("never emits prosody — HD voices don't support it; speed is applied at playback", () => {
    expect(buildSsml({ text: "hi", voice: "zh-CN-Xiaoxiao:DragonHDOmniLatestNeural" })).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">' +
        '<voice name="zh-CN-Xiaoxiao:DragonHDOmniLatestNeural">hi</voice></speak>',
    );
  });

  it("derives locale", () => {
    expect(voiceLocale("en-US-Ava:DragonHDLatestNeural")).toBe("en-US");
  });
});

describe("azure voices", () => {
  it("keeps neural and HD voices, grouped HD Omni → HD → Multilingual → Standard", () => {
    const voices = mapAzureVoices([
      { ShortName: "en-US-JennyNeural", LocalName: "Jenny", Locale: "en-US", VoiceType: "Neural" },
      { ShortName: "en-US-OldStandard", Locale: "en-US", VoiceType: "Standard" },
      { ShortName: "zh-CN-XiaoxiaoMultilingualNeural", LocalName: "晓晓", Locale: "zh-CN", VoiceType: "Neural" },
      // HD rows are kept whatever VoiceType says.
      { ShortName: "zh-CN-Xiaochen:DragonHDLatestNeural", Locale: "zh-CN", VoiceType: "NeuralHD" },
      { ShortName: "zh-CN-Xiaoxiao:DragonHDOmniLatestNeural", LocalName: "晓晓", Locale: "zh-CN" },
    ]);
    expect(voices.map((v) => [v.id, v.group])).toEqual([
      ["zh-CN-Xiaoxiao:DragonHDOmniLatestNeural", "HD Omni"],
      ["zh-CN-Xiaochen:DragonHDLatestNeural", "HD"],
      ["zh-CN-XiaoxiaoMultilingualNeural", "Multilingual"],
      ["en-US-JennyNeural", "Standard"],
    ]);
    expect(voices[0]).toMatchObject({ multilingual: true, label: "晓晓 (zh-CN)" });
    expect(voices[3].multilingual).toBe(false);
  });

  it("recognizes HD voices", () => {
    expect(isHdVoice("zh-CN-Xiaoxiao:DragonHDOmniLatestNeural")).toBe(true);
    expect(isHdVoice("zh-CN-Xiaoxiao:DragonHDFlashLatestNeural")).toBe(true);
    expect(isHdVoice("zh-CN-XiaoxiaoMultilingualNeural")).toBe(false);
  });

  it("validates voice ids", () => {
    expect(azureProvider.isValidVoice("zh-CN-XiaoxiaoMultilingualNeural")).toBe(true);
    expect(azureProvider.isValidVoice("en-US-Ava:DragonHDLatestNeural")).toBe(true);
    expect(azureProvider.isValidVoice("zh-cn-yunze_customer:DragonHDOmniLatestNeural")).toBe(true);
    expect(azureProvider.isValidVoice("zh-cn-guangxi-yunqi:DragonHDOmniLatestNeural")).toBe(true);
    expect(azureProvider.isValidVoice(azureProvider.defaultVoice)).toBe(true);
    expect(azureProvider.isValidVoice('x"><evil/>')).toBe(false);
  });
});

describe("azure synthesize", () => {
  it("posts SSML to the regional endpoint and returns the body stream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await azureProvider.synthesize(creds, { text: "你好", voice: "zh-CN-XiaoxiaoMultilingualNeural", signal: signal() });
    expect(result.contentType).toBe("audio/mpeg");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("k-123");
    expect(init.headers["X-Microsoft-OutputFormat"]).toMatch(/mp3/);
    expect(init.body).toContain(">你好</voice>");
  });

  it("refuses a region that could change the host, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      azureProvider.synthesize({ apiKey: "k", region: "evil.example.com/x" }, { text: "hi", voice: "en-US-AvaNeural", signal: signal() }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "quota"],
    [400, "bad_request"],
    [503, "upstream"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status })));
    const err = await azureProvider
      .synthesize(creds, { text: "hi", voice: "en-US-AvaNeural", signal: signal() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TtsProviderError);
    expect(err.kind).toBe(kind);
  });

  it("lets a timeout through instead of calling it a network error", async () => {
    // Behaves like real fetch: rejects with the signal's reason on abort.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
      ),
    );
    const err = await azureProvider
      .synthesize(creds, { text: "hi", voice: "en-US-AvaNeural", signal: AbortSignal.timeout(5) })
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(TtsProviderError);
    expect(err.name).toBe("TimeoutError");
  });

  it("hints at region support when an HD voice is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
    const hd = await azureProvider
      .synthesize(creds, { text: "hi", voice: "zh-CN-Xiaoxiao:DragonHDOmniLatestNeural", signal: signal() })
      .catch((e) => e);
    expect(hd.message).toMatch(/HD voices are only available in some Azure regions/);
    const standard = await azureProvider
      .synthesize(creds, { text: "hi", voice: "en-US-AvaNeural", signal: signal() })
      .catch((e) => e);
    expect(standard.message).not.toMatch(/region/);
  });

  it("maps connection failures to network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(
      azureProvider.synthesize(creds, { text: "hi", voice: "en-US-AvaNeural", signal: signal() }),
    ).rejects.toMatchObject({ kind: "network" });
  });
});
