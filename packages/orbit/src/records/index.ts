import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { Artifacts, LogChunk, Metrics } from "../contracts/index.ts";
import type { Redactor } from "../lib/redact.ts";

export const MAX_LOG_CHUNK = 1024 * 1024;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACTS = 2000;
const MAX_POINTS_PER_SERIES = 5000;

/** Read up to `limit` bytes of a log from `offset`. A negative offset reads the tail. */
export async function readLog(
  file: string,
  offset: number,
  limit: number,
  terminal: boolean,
  redactor?: Redactor,
): Promise<LogChunk> {
  const size = (await stat(file).catch(() => null))?.size ?? 0;
  const len = Math.min(Math.max(1, limit), MAX_LOG_CHUNK);
  let start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
  const context = Math.max(0, (redactor?.maxLength ?? 0) - 1);
  const end = Math.min(terminal ? size : Math.max(0, size - context), start + len);
  let text = "";
  if (end > start) {
    const fh = await open(file, "r");
    try {
      const readStart = Math.max(0, start - context);
      const buf = Buffer.alloc(Math.min(size, end + context) - readStart);
      const { bytesRead } = await fh.read(buf, 0, buf.length, readStart);
      // Never split a UTF-8 sequence: trim a partial trailing character, and skip a partial leading one.
      let from = start - readStart;
      let to = Math.min(end - readStart, bytesRead);
      if (offset < 0 && start > 0) {
        const nl = buf.indexOf(10, from);
        if (nl >= 0 && nl < to - 1) from = nl + 1;
      }
      while (from < to && ((buf[from] ?? 0) & 0xc0) === 0x80) from++;
      if (end < size || !terminal) to = from + safeUtf8End(buf.subarray(from, to));
      text = redactor
        ? redactor.applyWindow(buf.subarray(0, bytesRead), from, to)
        : buf.subarray(from, to).toString("utf8");
      start = readStart + from;
      return {
        offset: start,
        next: start + (to - from),
        size,
        text,
        eof: terminal && start + (to - from) >= size,
      };
    } finally {
      await fh.close();
    }
  }
  return { offset: start, next: start, size, text, eof: terminal && start >= size };
}

function safeUtf8End(buf: Buffer): number {
  // Walk back over continuation bytes to the lead byte and drop the sequence if incomplete.
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && ((buf[i] ?? 0) & 0xc0) === 0x80 && cont < 3) {
    i--;
    cont++;
  }
  if (i < 0) return buf.length;
  const lead = buf[i] ?? 0;
  const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
  return need > cont ? i : buf.length;
}

/** Parse `metrics.jsonl`: one JSON object per line; numeric fields become series keyed by name. */
export async function readMetrics(file: string): Promise<Metrics> {
  const series = new Map<string, [number, number][]>();
  let invalid = 0;
  let line = 0;
  const exists = await stat(file).catch(() => null);
  if (exists) {
    const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      line++;
      let obj: unknown;
      try {
        obj = JSON.parse(raw);
      } catch {
        invalid++;
        continue;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        invalid++;
        continue;
      }
      const rec = obj as Record<string, unknown>;
      const step = typeof rec.step === "number" ? rec.step : line;
      for (const [k, v] of Object.entries(rec)) {
        if (k === "step" || typeof v !== "number" || !Number.isFinite(v)) continue;
        const s = series.get(k);
        if (s) s.push([step, v]);
        else series.set(k, [[step, v]]);
      }
    }
  }
  const out: Metrics = { series: [], summary: {}, invalidLines: invalid };
  for (const [key, points] of [...series].sort(([a], [b]) => a.localeCompare(b))) {
    out.series.push({ key, points: downsample(points, MAX_POINTS_PER_SERIES) });
    const last = points.at(-1);
    if (last) out.summary[key] = last[1];
  }
  return out;
}

/** Keep every k-th point plus the last one; enough for review charts. */
export function downsample<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const k = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % k === 0);
  const last = points.at(-1);
  if (last !== undefined && out.at(-1) !== last) out.push(last);
  return out;
}

export async function listArtifacts(dir: string): Promise<Artifacts> {
  const files: Artifacts["files"] = [];
  let truncated = false;
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= MAX_ARTIFACTS) {
        truncated = true;
        return;
      }
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        // A running job may remove or rename a file between readdir and stat.
        const st = await stat(p).catch(() => null);
        if (st)
          files.push({ path: relative(dir, p), bytes: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  await walk(dir);
  return { files, truncated };
}

/** Resolve a user-supplied relative path inside `dir`, or null if it escapes. */
export function safeJoin(dir: string, rel: string): string | null {
  const root = resolve(dir);
  const p = resolve(root, rel);
  return p === root || p.startsWith(root + sep) ? p : null;
}

/** Open and verify the same descriptor that serves the response; never reopen a checked path. */
export async function outputFile(
  dir: string,
  rel: string,
  signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  const file = safeJoin(dir, rel);
  if (!file) return null;
  const root = await realpath(dir).catch(() => null);
  if (!root) return null;
  const fh = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => null);
  if (!fh) return null;
  let streaming = false;
  try {
    const [st, real] = await Promise.all([fh.stat(), realpath(`/proc/self/fd/${fh.fd}`)]);
    if (!st.isFile() || !real.startsWith(root + sep)) return null;
    // A stream created with an already aborted signal is destroyed before anything listens for
    // its error, which would take the process down.
    if (signal?.aborted) return null;
    const stream =
      st.size === 0
        ? Readable.from([])
        : fh.createReadStream({ start: 0, end: st.size - 1, autoClose: true, signal });
    const body = Readable.toWeb(stream, {
      strategy: { size: (chunk: Buffer) => chunk.length },
    }) as ReadableStream<Uint8Array>;
    streaming = st.size > 0;
    return { body, size: st.size };
  } finally {
    if (!streaming) await fh.close();
  }
}

/** The URL-encoded rest of `path` after `marker`; a malformed escape is a user error. */
export function decodePath(path: string, marker: string): string {
  const i = path.indexOf(marker);
  const raw = i < 0 ? "" : path.slice(i + marker.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new URIError(`malformed path: ${raw}`);
  }
}

export async function readDiff(file: string): Promise<{ patch: string; truncated: boolean }> {
  const st = await stat(file).catch(() => null);
  if (!st) return { patch: "", truncated: false };
  if (st.size <= MAX_DIFF_BYTES) return { patch: await readFile(file, "utf8"), truncated: false };
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(MAX_DIFF_BYTES);
    await fh.read(buf, 0, MAX_DIFF_BYTES, 0);
    return { patch: buf.toString("utf8"), truncated: true };
  } finally {
    await fh.close();
  }
}

/** Bytes used by the files under a directory (symlinks not followed); null if it does not exist. */
export async function dirBytes(dir: string): Promise<number | null> {
  const top = await lstat(dir).catch(() => null);
  if (!top) return null;
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await lstat(p).catch(() => null))?.size ?? 0;
    }
  };
  if (top.isDirectory()) await walk(dir);
  else total = top.size;
  return total;
}
