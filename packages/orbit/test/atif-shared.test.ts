import { describe, expect, it } from "vitest";
import {
  collectImage,
  nativeMetadata,
  parseNativeJsonl,
  type TrajectoryMedia,
} from "../src/sessions/atif.ts";

describe("native trajectory input", () => {
  it("keeps source line numbers and exposes malformed or non-object JSON", () => {
    expect(parseNativeJsonl('\r\n{"type":"user"}\r\nnull\r\n[]\r\n{broken\r\n')).toEqual({
      events: [{ line: 2, value: { type: "user" } }],
      issues: [
        { line: 3, type: "non-object-json" },
        { line: 4, type: "non-object-json" },
        { line: 5, type: "invalid-json" },
      ],
    });
  });

  it("deduplicates equivalent inline media into relative asset references", () => {
    const media: TrajectoryMedia[] = [];
    const first = collectImage("data:image/png;base64,aGVsbG8=", media);
    const second = collectImage(
      { type: "base64", media_type: "image/png", data: "aGVsbG8" },
      media,
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    expect(JSON.stringify(first)).not.toContain("aGVsbG8");
    expect(media).toHaveLength(1);
    expect(media[0]?.path).toMatch(/^media\/[a-f0-9]{64}\.png$/);
    expect(media[0]?.base64).toBe("aGVsbG8=");
  });

  it("returns a copy descriptor for referenced media without reading it", () => {
    const media: TrajectoryMedia[] = [];
    const part = collectImage({ url: "https://example.invalid/image.webp" }, media);
    expect(part).toMatchObject({ type: "image", source: { path: media[0]?.path } });
    expect(media[0]).toMatchObject({ sourcePath: "https://example.invalid/image.webp" });
    expect(media[0]).not.toHaveProperty("base64");
  });

  it("rejects malformed inline data and unsupported media types", () => {
    const media: TrajectoryMedia[] = [];
    for (const value of [
      "data:image/png;base64,?bad",
      "data:image/png;base64,a",
      "data:image/png;base64,",
      { type: "base64", media_type: "toString", data: "aGVsbG8=" },
      { type: "base64", media_type: "image/svg+xml", data: "aGVsbG8=" },
    ])
      expect(collectImage(value, media)).toBeNull();
    expect(media).toEqual([]);
  });

  it("keeps diagnostic structure without copying opaque or inline media payloads", () => {
    const value = {
      type: "future",
      nested: [{ encrypted_content: "secret", signature: "signed" }],
      source: { type: "base64", data: "aGVsbG8=", media_type: "image/png" },
      url: "data:image/png;base64,aGVsbG8=",
      retained: true,
    };
    const result = nativeMetadata(value);
    expect(result).toEqual({
      type: "future",
      nested: [{ opaque: true }],
      source: {
        type: "base64",
        opaque: true,
        media_type: "image/png",
      },
      url: { omitted: "inline-media" },
      retained: true,
    });
    expect(value.nested[0]?.encrypted_content).toBe("secret");
    expect(
      nativeMetadata({ type: "thinking", thinking: "signed body", signature: "signed" }),
    ).toEqual({ type: "thinking", opaque: true });
  });
});
