import { describe, it, expect } from "vitest";
import { base64ByteLength, sniffInlineImageType } from "./image-sniff";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe("sniffInlineImageType", () => {
  it("recognises the four model-visible formats by their leading bytes", () => {
    expect(sniffInlineImageType(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toBe("image/jpeg");
    expect(sniffInlineImageType(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("image/png");
    expect(sniffInlineImageType(b64([...Array.from("GIF89a", (c) => c.charCodeAt(0)), 1, 2]))).toBe("image/gif");
    const riffWebp = [...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WEBPVP8 ", (c) => c.charCodeAt(0))];
    expect(sniffInlineImageType(b64(riffWebp))).toBe("image/webp");
  });

  it("returns null for other images, non-images, and garbage", () => {
    expect(sniffInlineImageType(btoa("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffInlineImageType(btoa("%PDF-1.4 hello"))).toBeNull();
    expect(sniffInlineImageType(b64([0x42, 0x4d, 0, 0, 0, 0, 0, 0]))).toBeNull(); // BMP
    expect(sniffInlineImageType(b64([...Array.from("RIFF", (c) => c.charCodeAt(0)), 0, 0, 0, 0, ...Array.from("WAVE", (c) => c.charCodeAt(0))]))).toBeNull();
    expect(sniffInlineImageType("")).toBeNull();
    expect(sniffInlineImageType("!!!not base64!!!")).toBeNull();
  });

  it("does not need more than the head of the payload", () => {
    const pngHead = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect(sniffInlineImageType(pngHead + "A".repeat(100_000))).toBe("image/png");
  });
});

describe("base64ByteLength", () => {
  it("matches the decoded size for every padding case", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 100, 1023]) {
      const b = btoa(String.fromCharCode(...new Array(n).fill(0x41)));
      expect(base64ByteLength(b)).toBe(n);
    }
  });
});
