import { createHash } from "node:crypto";
import type { AtifContentPart, AtifTrajectory } from "../contracts/atif.ts";

export interface TrajectoryOptions {
  sessionId?: string;
  sourcePath?: string;
  run?: string;
  cliVersion?: string;
}

export type TrajectoryMedia = { path: string; mediaType: string } & (
  | { base64: string; sourcePath?: never }
  | { sourcePath: string; base64?: never }
);

export interface TrajectoryConversion {
  trajectory: AtifTrajectory;
  media: TrajectoryMedia[];
}

export interface NativeEvent {
  value: Record<string, unknown>;
  line: number;
}

export function parseNativeJsonl(input: string): {
  events: NativeEvent[];
  issues: { line: number; type: string }[];
} {
  const events: NativeEvent[] = [];
  const issues: { line: number; type: string }[] = [];
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        issues.push({ line: index + 1, type: "non-object-json" });
      } else {
        events.push({ value: value as Record<string, unknown>, line: index + 1 });
      }
    } catch {
      issues.push({ line: index + 1, type: "invalid-json" });
    }
  }
  return { events, issues };
}

const IMAGE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

/** Return assets for the caller to materialize; conversion itself never reads or writes files. */
export function collectImage(source: unknown, media: TrajectoryMedia[]): AtifContentPart | null {
  const object =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const value = typeof source === "string" ? source : (object.url ?? object.path);
  let mediaType = typeof object.media_type === "string" ? object.media_type : "";
  let base64: string | undefined;
  let sourcePath: string | undefined;
  if (typeof object.data === "string" && object.type === "base64") {
    base64 = object.data;
  } else if (typeof value === "string" && value.startsWith("data:")) {
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([\s\S]*)$/.exec(value);
    if (!match) return null;
    mediaType = match[1] ?? "";
    base64 = match[2];
  } else if (typeof value === "string" && value.length > 0) {
    sourcePath = value;
    if (!mediaType) {
      const extension = value.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
      mediaType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    }
  } else {
    return null;
  }
  if (!Object.hasOwn(IMAGE_EXTENSIONS, mediaType)) return null;
  let digest: string;
  if (base64 !== undefined) {
    base64 = base64.replace(/\s/g, "");
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) return null;
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) return null;
    base64 = bytes.toString("base64");
    digest = createHash("sha256").update(bytes).digest("hex");
  } else {
    digest = createHash("sha256")
      .update(sourcePath ?? "")
      .digest("hex");
  }
  const type = mediaType as keyof typeof IMAGE_EXTENSIONS;
  const path = `media/${digest}.${IMAGE_EXTENSIONS[type]}`;
  if (!media.some((asset) => asset.path === path)) {
    media.push(
      base64 !== undefined
        ? { path, mediaType, base64 }
        : { path, mediaType, sourcePath: sourcePath as string },
    );
  }
  return { type: "image", source: { media_type: type, path } };
}

/** Diagnostics retain native structure, but opaque payloads remain only in the source file. */
export function nativeMetadata(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:")) return { omitted: "inline-media" };
  if (Array.isArray(value)) return value.map(nativeMetadata);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const opaqueReasoning =
    ["thinking", "reasoning", "redacted_thinking"].includes(String(record.type)) &&
    (record.signature != null ||
      record.encrypted_content != null ||
      record.type === "redacted_thinking");
  for (const [key, item] of Object.entries(record)) {
    if (
      (opaqueReasoning && ["thinking", "text", "content", "summary", "data"].includes(key)) ||
      key === "encrypted_content" ||
      key === "signature" ||
      (key === "data" && (record.type === "base64" || record.type === "redacted_thinking"))
    ) {
      out.opaque = true;
    } else {
      out[key] = nativeMetadata(item);
    }
  }
  return out;
}
