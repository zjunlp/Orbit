import { afterEach, expect, it, vi } from "vitest";
import { episodeVideo } from "../src/lib/episode-video.ts";

afterEach(() => vi.unstubAllGlobals());
it("gives saved videos their media type even when the artifact API sends plain text", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "text/plain" } }),
      ),
  );
  const blob = await episodeVideo("/saved", "camera.webm", new AbortController().signal);
  expect(blob.type).toBe("video/webm");
  expect(blob.size).toBe(3);
});
it("rejects a growing response before buffering beyond the preview budget", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5, 6]));
            controller.close();
          },
        }),
      ),
    ),
  );
  await expect(
    episodeVideo("/saved", "camera.mp4", new AbortController().signal, 4),
  ).rejects.toThrow("preview limit");
});
it("rejects unrecognized formats before requesting the artifact", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(episodeVideo("/saved", "camera.html", new AbortController().signal)).rejects.toThrow(
    "supports",
  );
  expect(fetch).not.toHaveBeenCalled();
});
