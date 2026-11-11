// How the trial page shows what an adapter declared in `review` (pure, for tests). The kinds are a
// closed set rendered with Orbit's own styles; a kind this Web UI does not know falls back to the
// declared `fallback`, then to the file extension, then to plain text, and says so.
import type { ReviewFile } from "./api.ts";
import { videoType } from "./episode-video.ts";

/** Must match `REVIEW_KINDS` in the contracts (checked by a test). */
export const KNOWN_KINDS = [
  "markdown",
  "image",
  "video",
  "text",
  "json",
  "table",
  "trajectory",
  "episode",
  "conversation",
] as const;
export type Kind = (typeof KNOWN_KINDS)[number];

const isKnown = (k: string | undefined): k is Kind =>
  k !== undefined && (KNOWN_KINDS as readonly string[]).includes(k);

const BY_EXT: [RegExp, Kind][] = [
  [/\.(md|markdown)$/i, "markdown"],
  [/\.(png|jpe?g|gif|svg|webp)$/i, "image"],
  [/\.json$/i, "json"],
  [/\.(csv|tsv)$/i, "table"],
];

/** The kind to render a file with, and a note when the declared kind was not understood. */
export function resolveKind(f: Pick<ReviewFile, "kind" | "fallback" | "path">): {
  kind: Kind;
  note: string | null;
} {
  if (isKnown(f.kind)) return { kind: f.kind, note: null };
  const unknown = f.kind ? `unknown kind "${f.kind}"` : null;
  if (isKnown(f.fallback))
    return { kind: f.fallback, note: unknown && `${unknown}, shown as ${f.fallback}` };
  const ext = videoType(f.path) ? "video" : BY_EXT.find(([re]) => re.test(f.path))?.[1];
  if (ext) return { kind: ext, note: unknown && `${unknown}, shown as ${ext} (file extension)` };
  return { kind: "text", note: unknown && `${unknown}, shown as text` };
}

/** Review fields this UI renders; any other field is listed under Details. */
export const REVIEW_FIELDS = ["files", "items", "details"] as const;

/** Fields of an object outside `known`: kept from newer adapters and listed, never dropped. */
export function extraFields(obj: object, known: readonly string[]): [string, unknown][] {
  return Object.entries(obj).filter(([k, v]) => !known.includes(k) && v !== undefined);
}

/** A value of an unknown field as one line of text. */
export function showValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}
