import { describe, it, expect, afterEach, vi } from "vitest";
import { clampRate, defaultTtsConfig, isTtsConfigured, maskSecret, parseTtsConfig, resolveCredentials } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("parseTtsConfig", () => {
  it("defaults on missing or garbage input", () => {
    expect(parseTtsConfig(undefined)).toEqual(defaultTtsConfig());
    expect(parseTtsConfig("not json")).toEqual(defaultTtsConfig());
    expect(parseTtsConfig("null")).toEqual(defaultTtsConfig());
  });

  it("normalizes unknown provider, invalid voice and out-of-range rate", () => {
    const config = parseTtsConfig(JSON.stringify({ provider: "nope", voice: "<bad>", rate: 9, credentials: { azure: { apiKey: "k", region: 5, extra: "x" } } }));
    expect(config.provider).toBe("azure");
    expect(config.voice).toBe(defaultTtsConfig().voice);
    expect(config.rate).toBe(2);
    expect(config.credentials.azure).toEqual({ apiKey: "k" });
  });

  it("keeps a valid voice", () => {
    expect(parseTtsConfig(JSON.stringify({ voice: "en-US-AvaNeural" })).voice).toBe("en-US-AvaNeural");
  });
});

describe("credentials", () => {
  it("falls back to env per field", () => {
    vi.stubEnv("AZURE_SPEECH_KEY", "env-key");
    vi.stubEnv("AZURE_SPEECH_REGION", "");
    const config = { ...defaultTtsConfig(), credentials: { azure: { region: "westus" } } };
    expect(resolveCredentials(config)).toEqual({ apiKey: "env-key", region: "westus" });
    expect(isTtsConfigured(config)).toBe(true);
  });

  it("is unconfigured when a field is missing everywhere", () => {
    vi.stubEnv("AZURE_SPEECH_KEY", "");
    vi.stubEnv("AZURE_SPEECH_REGION", "");
    expect(isTtsConfigured({ ...defaultTtsConfig(), credentials: { azure: { apiKey: "k" } } })).toBe(false);
  });
});

describe("helpers", () => {
  it("clamps rate", () => {
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(NaN)).toBe(1);
    expect(clampRate(1.234)).toBe(1.23);
  });

  it("masks secrets", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret("abc")).toBe("****");
    expect(maskSecret("abcdefgh")).toBe("****efgh");
  });
});
