import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface SessionRoots {
  claude: string;
  codex: string;
}

export function sessionRoots(env: NodeJS.ProcessEnv = process.env): SessionRoots {
  return {
    claude: join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    codex: join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
  };
}

/** Session ids are UUID-like; anything else could name a path outside the session roots. */
const SESSION_ID = /^[A-Za-z0-9-]{8,128}$/;

// ---- Claude Code: <projects>/<escaped cwd>/<sessionId>.jsonl ----

export async function findClaudeSession(
  roots: SessionRoots,
  sessionId: string,
): Promise<string | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const dirs = await readdir(roots.claude).catch(() => [] as string[]);
  for (const d of dirs) {
    const f = join(roots.claude, d, `${sessionId}.jsonl`);
    if (await stat(f).catch(() => null)) return f;
  }
  return null;
}

// ---- Codex: <sessions>/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl ----

async function codexFiles(roots: SessionRoots, days = 7): Promise<string[]> {
  const files: string[] = [];
  const years = (await readdir(roots.codex).catch(() => [] as string[])).sort().reverse();
  outer: for (const y of years) {
    const months = (await readdir(join(roots.codex, y)).catch(() => [] as string[]))
      .sort()
      .reverse();
    for (const m of months) {
      const ds = (await readdir(join(roots.codex, y, m)).catch(() => [] as string[]))
        .sort()
        .reverse();
      for (const d of ds) {
        const dir = join(roots.codex, y, m, d);
        const names = await readdir(dir).catch(() => [] as string[]);
        files.push(...names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n)));
        if (--days <= 0) break outer;
      }
    }
  }
  return files;
}

async function firstLine(file: string): Promise<Record<string, unknown> | null> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) throw new Error("unsafe session file");
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const nl = text.indexOf("\n");
    try {
      return JSON.parse(nl >= 0 ? text.slice(0, nl) : text);
    } catch {
      return null;
    }
  } finally {
    await fh.close();
  }
}

export async function findCodexSession(
  roots: SessionRoots,
  ref: { sessionId?: string; cwd?: string },
): Promise<{ file: string; sessionId: string } | null> {
  if (ref.sessionId && !SESSION_ID.test(ref.sessionId)) return null;
  const files = await codexFiles(roots, ref.sessionId ? 60 : 3);
  if (ref.sessionId) {
    const f = files.find((x) => x.endsWith(`-${ref.sessionId}.jsonl`));
    return f ? { file: f, sessionId: ref.sessionId } : null;
  }
  // No id: the most recently active session started in the same directory.
  const withTime = await Promise.all(
    files.map(async (f) => ({ f, t: (await stat(f).catch(() => null))?.mtimeMs ?? 0 })),
  );
  for (const { f } of withTime.sort((a, b) => b.t - a.t).slice(0, 50)) {
    const meta = await firstLine(f).catch(() => null);
    const p = meta?.payload as { cwd?: string; id?: string } | undefined;
    if (meta?.type === "session_meta" && p?.id && p.cwd === ref.cwd) {
      return { file: f, sessionId: p.id };
    }
  }
  return null;
}

/** All `.jsonl` files below `dir` (depth-limited), newest first. */
export async function jsonlBelow(
  dir: string,
  depth: number,
): Promise<{ file: string; mtime: number }[]> {
  const out: { file: string; mtime: number }[] = [];
  const walk = async (d: string, left: number) => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(d, e.name);
      // Claude Code keeps subagent transcripts in their own directories: not the main session.
      if (e.isDirectory() && left > 0 && e.name !== "subagents") await walk(p, left - 1);
      else if (e.isFile() && e.name.endsWith(".jsonl"))
        out.push({ file: p, mtime: (await stat(p).catch(() => null))?.mtimeMs ?? 0 });
    }
  };
  await walk(dir, depth);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

/** Read the checked descriptor, bound memory, and refuse links escaping the supplied root. */
export async function readSessionInput(
  file: string,
  root = dirname(file),
  max = MAX_SESSION_BYTES,
  encoding: BufferEncoding = "utf8",
): Promise<string> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const [st, actual, base] = await Promise.all([
      fh.stat(),
      realpath(`/proc/self/fd/${fh.fd}`),
      realpath(root),
    ]);
    if (!st.isFile() || !actual.startsWith(base + sep)) throw new Error("unsafe session file");
    if (st.size > max) throw new Error(`session exceeds ${max} bytes`);
    const data = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await fh.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return data.subarray(0, offset).toString(encoding);
  } finally {
    await fh.close();
  }
}

export async function findRunSession(
  agentDir: string,
): Promise<{ file: string; harness: "codex" | "claude-code"; sessionId: string | null } | null> {
  const candidates = [
    ...(await jsonlBelow(join(agentDir, "codex", "sessions"), 4)).map((f) => ({
      ...f,
      harness: "codex" as const,
    })),
    ...(await jsonlBelow(join(agentDir, "claude", "projects"), 2)).map((f) => ({
      ...f,
      harness: "claude-code" as const,
    })),
  ].sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    if (!(await realpath(candidate.file)).startsWith(resolve(agentDir) + sep))
      throw new Error("session leaves Agent home");
    // Codex child rollouts can be newer than the root session.
    const metadata = await firstLine(candidate.file);
    const payload = metadata?.payload as { source?: unknown; id?: unknown } | undefined;
    if (candidate.harness === "codex") {
      if (payload?.source && typeof payload.source === "object" && "subagent" in payload.source)
        continue;
    }
    const sessionId =
      candidate.harness === "claude-code"
        ? basename(candidate.file, ".jsonl")
        : typeof payload?.id === "string"
          ? payload.id
          : (/([0-9a-f-]{36})\.jsonl$/i.exec(candidate.file)?.[1] ?? null);
    return { ...candidate, sessionId };
  }
  return null;
}

/** Checkpoints need the native resume ID even before the first model turn is recorded. */
export async function runAgentSession(agentDir: string) {
  const source = await findRunSession(agentDir);
  return source?.sessionId ? { harness: source.harness, sessionId: source.sessionId } : null;
}
