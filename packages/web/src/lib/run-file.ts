// Loading one saved output file of a run for a trial view: find it in the run's listing, refuse
// files over the view's preview limit before fetching, then read and parse it.
import { useMemo } from "react";
import { type Artifacts, api, fileUrl, type Run } from "./api.ts";
import { type Async, useAsync } from "./use.ts";

/** Read a run output file as text; `what` names it in errors ("the trajectory"). */
export async function readRunFile(
  runId: string,
  path: string,
  what: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<string> {
  const response = await fetch(fileUrl(runId, path));
  if (!response.ok) throw new Error(`Could not read ${what} (${response.status}).`);
  const text = await response.text();
  // The file may have grown since it was listed.
  if (text.length > maxBytes) throw new Error(`${capital(what)} exceeds the preview limit.`);
  return text;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface RunFile<T> {
  /** The run's output listing, for linked files and truncation notes. */
  listing: Async<Artifacts>;
  entry: Artifacts["files"][number] | undefined;
  /** The listing loaded without the file. */
  missing: boolean;
  /** Larger than the preview limit, so not fetched. */
  tooLarge: boolean;
  data: T | undefined;
  /** Why the listing, the file or its parsing failed. */
  error: string | null;
}

export function useRunFile<T>(
  run: Run,
  path: string,
  opts: { what: string; maxBytes: number; parse: (text: string) => T; skip?: boolean },
): RunFile<T> {
  const listing = useAsync(() => api.artifacts(run.id), [run.id, run.state]);
  const entry = useMemo(
    () => listing.data?.files.find((item) => item.path === path),
    [listing.data, path],
  );
  const tooLarge = !!entry && entry.bytes > opts.maxBytes;
  const read = !!entry && !tooLarge && !opts.skip;
  const source = useAsync(
    async () =>
      read ? opts.parse(await readRunFile(run.id, path, opts.what, opts.maxBytes)) : undefined,
    [run.id, path, read, entry?.bytes, entry?.mtime],
  );
  return {
    listing,
    entry,
    missing: !!listing.data && !entry,
    tooLarge,
    data: read ? source.data : undefined,
    error: listing.error ?? (read ? source.error : null),
  };
}
