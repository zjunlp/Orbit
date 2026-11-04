const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

/** The current artifact API has no video MIME/Range support. Bound an in-memory preview explicitly. */
export async function episodeVideo(
  url: string,
  path: string,
  signal: AbortSignal,
  limit = MAX_VIDEO_BYTES,
) {
  const tooLarge = `Video exceeds the ${(limit / 1024 / 1024).toFixed(1)} MiB per-camera preview limit (64 MiB total per episode). Download the original video.`;
  const type = VIDEO_TYPES[path.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!type) throw new Error("Video preview supports MP4, WebM and Ogg files.");
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error("The saved video could not be read.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error(tooLarge);
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error(tooLarge);
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return new Blob(chunks, { type });
}
