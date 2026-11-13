import { createHash } from "node:crypto";
import { type AtifContentPart, type AtifSource, AtifTrajectory } from "../contracts/index.ts";
import { collectImage, type TrajectoryConversion, type TrajectoryMedia } from "./atif.ts";

const audioExtensions: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "weba",
  "audio/aiff": "aiff",
};
/** Validate native ATIF without renumbering steps, repricing usage or converting its version. */
export function importAtif(input: string, source: AtifSource): TrajectoryConversion {
  const trajectory = AtifTrajectory.parse(JSON.parse(input));
  const media: TrajectoryMedia[] = [];
  const hash = createHash("sha256").update(input).digest("hex");
  const content = (value: string | AtifContentPart[]): string | AtifContentPart[] =>
    typeof value === "string"
      ? value
      : value.map((part) => {
          if (part.type === "text") return part;
          if (part.type === "image") {
            const image = collectImage(part.source, media);
            if (image?.type !== "image") throw new Error("invalid ATIF image source");
            return { ...part, source: image.source };
          }
          const path = `media/${createHash("sha256").update(part.source.path).digest("hex")}.${audioExtensions[part.source.media_type]}`;
          if (!media.some((asset) => asset.path === path))
            media.push({ path, mediaType: part.source.media_type, sourcePath: part.source.path });
          return { ...part, source: { ...part.source, path } };
        });
  const visit = (t: AtifTrajectory) => {
    const previous = t.extra?.orbit;
    const missing = t.steps.some((step) =>
      step.tool_calls?.some(
        (call) =>
          !step.observation?.results.some((result) => result.source_call_id === call.tool_call_id),
      ),
    );
    for (const step of t.steps) {
      step.message = content(step.message);
      for (const result of step.observation?.results ?? [])
        if (result.content != null) result.content = content(result.content);
    }
    for (const child of t.subagent_trajectories ?? []) visit(child);
    t.extra = {
      ...t.extra,
      orbit: {
        version: 1,
        importer: { name: "atif-import", version: 1 },
        sources: [{ path: source.path, sha256: hash, bytes: Buffer.byteLength(input) }],
        completeness:
          previous?.completeness === "truncated" ||
          missing ||
          t.subagent_trajectories?.some((child) => child.extra?.orbit?.completeness === "truncated")
            ? "truncated"
            : "agent-only",
        metadata: {
          source,
          source_root: "output",
          ...(previous ? { upstream_orbit: previous } : {}),
        },
      },
    };
  };
  visit(trajectory);
  return { trajectory: AtifTrajectory.parse(trajectory), media };
}
