// How the trial page shows what an adapter declared in `review` (pure, for tests). The kinds are a
// closed set rendered with Orbit's own styles; a kind this Web UI does not know falls back to the
// declared `fallback`, then to the file extension, then to plain text, and says so.
import type { ReviewFile, ReviewItem } from "./api.ts";
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
  "tests",
] as const;
export type Kind = (typeof KNOWN_KINDS)[number];

const isKnown = (k: string | undefined): k is Kind =>
  k !== undefined && (KNOWN_KINDS as readonly string[]).includes(k);

// `ctrf.json` is the conventional name of a Common Test Report Format file, so verifier output
// stored before the `tests` kind existed is still read as a test report.
const BY_EXT: [RegExp, Kind][] = [
  [/(^|[/._-])ctrf\.json$/i, "tests"],
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

/** Kinds replayed step by step: the main view of a trial, and what a Markdown transcript repeats. */
const REPLAY: readonly Kind[] = ["trajectory", "conversation", "episode"];
export const isReplay = (f: Pick<ReviewFile, "kind" | "fallback" | "path">) =>
  REPLAY.includes(resolveKind(f).kind);

/**
 * How the declared files become tabs. `main` are the views a trial is read through (replays, then
 * test reports), `documents` are reports and videos with a tab of their own, and `rest` is every
 * other file: grouped under one Evidence tab, or a tab of its own when it is the only one. Next to
 * a replay, documents and videos are renditions of it and belong to the rest.
 */
export function reviewTabs(files: readonly Pick<ReviewFile, "kind" | "fallback" | "path">[]): {
  main: number[];
  documents: number[];
  rest: number[];
} {
  const kinds = files.map((f) => resolveKind(f).kind);
  const replay = kinds.some((k) => REPLAY.includes(k));
  const rank = (k: Kind) => {
    if (REPLAY.includes(k)) return 0;
    if (k === "tests") return 1;
    return !replay && (k === "markdown" || k === "video") ? 2 : 3;
  };
  const of = (r: number) => kinds.flatMap((k, i) => (rank(k) === r ? [i] : []));
  return { main: [...of(0), ...of(1)], documents: of(2), rest: of(3) };
}

/** The link to a declared file on the trial page, whichever tab holds it. */
export function fileHref(
  files: readonly Pick<ReviewFile, "kind" | "fallback" | "path">[],
  index: number,
): string {
  const { rest } = reviewTabs(files);
  return rest.length > 1 && rest.includes(index) ? `?tab=evidence&file=${index}` : `?tab=f${index}`;
}

/** The tab label of a file: a test report declared by its bare file name reads "Tests". */
export function fileLabel(f: Pick<ReviewFile, "label" | "kind" | "fallback" | "path">): string {
  const bare = f.label === f.path.slice(f.path.lastIndexOf("/") + 1);
  return bare && resolveKind(f).kind === "tests" ? "Tests" : f.label;
}

export type ItemState = "full" | "partial" | "zero" | "scored" | "none";

/** What a graded criterion earned; `scored` has a score without a maximum to compare it with. */
export function itemState(it: Pick<ReviewItem, "score" | "maxScore">): ItemState {
  if (it.score == null) return "none";
  if (it.maxScore === undefined || it.maxScore <= 0) return "scored";
  return it.score >= it.maxScore ? "full" : it.score <= 0 ? "zero" : "partial";
}

/** Review fields this UI renders; any other field is listed under Details. */
export const REVIEW_FIELDS = ["files", "items", "details"] as const;

/** Fields of an object outside `known`: kept from newer adapters and listed, never dropped. */
export function extraFields(obj: object, known: readonly string[]): [string, unknown][] {
  return Object.entries(obj).filter(([k, v]) => !known.includes(k) && v !== undefined);
}

/** Nothing to show: an absent value, or an empty string, list or object. */
export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && Object.keys(v).length === 0;
}

/** A value of an unknown field as one line of text. */
export function showValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}
