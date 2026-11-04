import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentRef, SessionMessage, SessionTranscript } from "../contracts/index.ts";
import { agentErrorKind } from "../harness/index.ts";

const MAX_TEXT = 8000;
const MAX_TOOL_TEXT = 4000;
const MAX_MESSAGES = 5000;

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

function clip(text: string, max: number): { text: string; truncated?: boolean } {
  return text.length <= max ? { text } : { text: text.slice(0, max), truncated: true };
}

async function* jsonLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") yield v as Record<string, unknown>;
    } catch {}
  }
}

const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2);

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

type Block = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
};

export async function parseClaude(file: string): Promise<SessionMessage[]> {
  const out: SessionMessage[] = [];
  const toolNames = new Map<string, string>();
  for await (const e of jsonLines(file)) {
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain === true) continue;
    const at = typeof e.timestamp === "string" ? e.timestamp : null;
    const msg = e.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (typeof content === "string") {
      out.push({ at, role: e.type, kind: "text", ...clip(content, MAX_TEXT) });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (b.type === "text" && b.text)
        out.push({ at, role: e.type, kind: "text", ...clip(b.text, MAX_TEXT) });
      else if (b.type === "thinking" && b.thinking)
        out.push({ at, role: "assistant", kind: "thinking", ...clip(b.thinking, MAX_TEXT) });
      else if (b.type === "tool_use") {
        if (b.id && b.name) toolNames.set(b.id, b.name);
        out.push({
          at,
          role: "assistant",
          kind: "tool_call",
          name: b.name,
          ...clip(str(b.input), MAX_TOOL_TEXT),
        });
      } else if (b.type === "tool_result") {
        const c = Array.isArray(b.content)
          ? (b.content as Block[]).map((x) => x.text ?? `[${x.type}]`).join("\n")
          : str(b.content);
        const name = b.tool_use_id ? toolNames.get(b.tool_use_id) : undefined;
        out.push({ at, role: "tool", kind: "tool_result", name, ...clip(c, MAX_TOOL_TEXT) });
      }
    }
  }
  return out;
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
  const fh = await open(file, "r");
  try {
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

/**
 * Newer Codex versions call tools through a JS `exec` tool (`tools.exec_command({cmd:"..."})`).
 * Show the shell commands it ran instead of the script when they can be extracted.
 */
export function codexCallText(input: string): string {
  const cmds: string[] = [];
  for (const m of input.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      cmds.push(`$ ${JSON.parse(m[1] as string)}`);
    } catch {}
  }
  return cmds.length ? cmds.join("\n") : input;
}

/** Tool output as text: content-part arrays are joined, `exec_command` results unwrapped. */
export function codexOutputText(o: unknown): string {
  if (typeof o === "object" && o && !Array.isArray(o) && "content" in o) {
    return codexOutputText((o as { content: unknown }).content);
  }
  if (!Array.isArray(o)) return str(o);
  return o
    .map((part: { text?: unknown }) => {
      const text = typeof part?.text === "string" ? part.text : str(part);
      try {
        type Result = { output?: unknown; exit_code?: unknown };
        const v = JSON.parse(text) as Result & { value?: Result };
        const r = v?.value ?? v;
        if (typeof r?.output === "string") {
          const code = r.exit_code;
          return code === 0 || code === undefined ? r.output : `[exit ${code}]\n${r.output}`;
        }
      } catch {}
      return text;
    })
    .join("\n");
}

export async function parseCodex(file: string): Promise<SessionMessage[]> {
  const out: SessionMessage[] = [];
  const callNames = new Map<string, string>();
  for await (const e of jsonLines(file)) {
    if (e.type !== "response_item") continue;
    const at = typeof e.timestamp === "string" ? e.timestamp : null;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (p.type) {
      case "message": {
        const role = p.role === "assistant" ? "assistant" : p.role === "user" ? "user" : "system";
        const text = ((p.content as { text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
        if (text) out.push({ at, role, kind: "text", ...clip(text, MAX_TEXT) });
        break;
      }
      case "reasoning": {
        const text = ((p.summary as { text?: string }[]) ?? []).map((s) => s.text ?? "").join("\n");
        if (text) out.push({ at, role: "assistant", kind: "thinking", ...clip(text, MAX_TEXT) });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        const name = str(p.name);
        if (typeof p.call_id === "string") callNames.set(p.call_id, name);
        out.push({
          at,
          role: "assistant",
          kind: "tool_call",
          name,
          ...clip(
            p.type === "custom_tool_call" && typeof p.input === "string"
              ? codexCallText(p.input)
              : str(p.arguments ?? p.input),
            MAX_TOOL_TEXT,
          ),
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const text = codexOutputText(p.output);
        const name = typeof p.call_id === "string" ? callNames.get(p.call_id) : undefined;
        out.push({ at, role: "tool", kind: "tool_result", name, ...clip(text, MAX_TOOL_TEXT) });
        break;
      }
    }
  }
  return out;
}

/** Resolve a session id when the submitter could not provide one (Codex). */
export async function resolveAgentRef(ref: AgentRef, roots = sessionRoots()): Promise<AgentRef> {
  if (ref.sessionId || ref.harness !== "codex") return ref;
  const hit = await findCodexSession(roots, ref);
  return hit ? { ...ref, sessionId: hit.sessionId } : ref;
}

export async function loadTranscript(
  ref: AgentRef,
  roots = sessionRoots(),
): Promise<SessionTranscript | null> {
  if (!ref.sessionId) return null;
  let file: string | null = null;
  let messages: SessionMessage[] = [];
  if (ref.harness === "claude-code") {
    file = await findClaudeSession(roots, ref.sessionId);
    if (file) messages = await parseClaude(file);
  } else if (ref.harness === "codex") {
    file = (await findCodexSession(roots, ref))?.file ?? null;
    if (file) messages = await parseCodex(file);
  }
  if (!file) return null;
  return {
    harness: ref.harness,
    sessionId: ref.sessionId,
    file,
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/** All `.jsonl` files below `dir` (depth-limited), newest first. */
async function jsonlBelow(dir: string, depth: number): Promise<{ file: string; mtime: number }[]> {
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

/**
 * The session of an Agent that ran inside the run (its home is kept in the run directory as
 * `<agentDir>/codex` or `<agentDir>/claude`): the most recently written transcript.
 */
export async function loadRunAgentTranscript(agentDir: string): Promise<SessionTranscript | null> {
  const candidates = [
    ...(await jsonlBelow(join(agentDir, "codex", "sessions"), 4)).map((f) => ({
      ...f,
      harness: "codex",
    })),
    ...(await jsonlBelow(join(agentDir, "claude", "projects"), 2)).map((f) => ({
      ...f,
      harness: "claude-code",
    })),
  ].sort((a, b) => b.mtime - a.mtime);
  const hit = candidates[0];
  if (!hit) return null;
  const messages =
    hit.harness === "codex" ? await parseCodex(hit.file) : await parseClaude(hit.file);
  const base =
    hit.file
      .split("/")
      .pop()
      ?.replace(/\.jsonl$/, "") ?? "";
  const id = /([0-9a-f]{8}-[0-9a-f-]{27,})$/i.exec(base)?.[1] ?? base;
  return {
    harness: hit.harness,
    sessionId: id,
    file: hit.file,
    messages: messages.slice(-MAX_MESSAGES),
  };
}

export interface AgentFailure {
  kind: string;
  message: string;
}

const errorText = (v: unknown): string => {
  const m = (v as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : typeof v === "string" ? v : JSON.stringify(v ?? "");
};

/** Only CLI-owned response events count; user text and tool output never prove model access. */
function codexModelResponse(e: Record<string, unknown>): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === "response_item") {
    if (p.type === "function_call" || p.type === "custom_tool_call")
      return typeof p.name === "string" && p.name.length > 0;
    if (p.type === "reasoning")
      return (
        (typeof p.encrypted_content === "string" && p.encrypted_content.length > 0) ||
        (Array.isArray(p.summary) && p.summary.some((part) => Boolean(part?.text)))
      );
    return (
      p.type === "message" &&
      p.role === "assistant" &&
      Array.isArray(p.content) &&
      p.content.some((part) => typeof part?.text === "string" && part.text.length > 0)
    );
  }
  if (e.type !== "event_msg") return false;
  if (p.type === "agent_message") return typeof p.message === "string" && p.message.length > 0;
  if (p.type === "agent_reasoning") return typeof p.text === "string" && p.text.length > 0;
  return (
    p.type === "task_complete" &&
    !p.error &&
    typeof p.last_agent_message === "string" &&
    p.last_agent_message.length > 0
  );
}

function claudeModelResponse(e: Record<string, unknown>): boolean {
  if (e.type !== "assistant" || e.isApiErrorMessage === true || e.isSidechain === true)
    return false;
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.length > 0;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        (part.type === "text" && Boolean(part.text)) ||
        (part.type === "thinking" && Boolean(part.thinking)) ||
        (part.type === "tool_use" && Boolean(part.name)),
    )
  );
}

/**
 * An explicit final model error invalidates a run only if the session contains no successful
 * model response. Errors in user/tool content are ignored; partial model work is still scored.
 */
export async function runAgentFailure(
  agentDir: string,
  log?: string,
  redact: (text: string) => string = (text) => text,
): Promise<AgentFailure | null> {
  let text: string | null = null;
  let code: unknown;
  let responded = false;
  const codex = (await jsonlBelow(join(agentDir, "codex", "sessions"), 4))[0];
  if (codex) {
    let open = false;
    for await (const e of jsonLines(codex.file)) {
      responded ||= codexModelResponse(e);
      const p = e.payload as { type?: unknown; error?: unknown } | undefined;
      if (e.type !== "event_msg") continue;
      if (p?.type === "task_started") {
        open = true;
        text = null;
        code = undefined;
      } else if (p?.type === "task_complete") {
        open = false;
        text = p.error ? errorText(p.error) : null;
        code = (p.error as { codex_error_info?: unknown } | null)?.codex_error_info;
      }
    }
    if (responded) return null;
    if (open && log) {
      const failure = await codexFailureAtEnd(log);
      return failure ? { ...failure, message: clip(redact(failure.message), 200).text } : null;
    }
  } else {
    const claude = (await jsonlBelow(join(agentDir, "claude", "projects"), 2))[0];
    if (!claude) return null;
    for await (const e of jsonLines(claude.file)) {
      if (e.type !== "assistant" || e.isSidechain === true) continue;
      responded ||= claudeModelResponse(e);
      const content = (e.message as { content?: unknown } | undefined)?.content;
      const message =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
            : "API error";
      text = e.isApiErrorMessage === true ? message : null;
      code = e.isApiErrorMessage === true ? e.error : undefined;
    }
  }
  if (responded) return null;
  const kind = text !== null ? agentErrorKind(text, code) : null;
  return kind && text !== null
    ? { kind, message: clip(redact(text || "API error"), 200).text }
    : null;
}

/** Codex's stderr while it retries the model connection, e.g. `ERROR: Reconnecting... 3/5`. */
const RECONNECTING = /^ERROR: Reconnecting\.\.\./;
const TOKEN_REFRESH_REJECTED =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ERROR codex_login::auth::manager: Failed to refresh token(?: status=|: (?:Failed to refresh token: )?)403 Forbidden$/;

/**
 * Codex may keep retrying without closing its transcript turn. Accept only native terminal errors;
 * generic HTTP failures or user/tool text do not establish a model failure.
 */
async function codexFailureAtEnd(log: string): Promise<AgentFailure | null> {
  const fh = await open(log, "r").catch(() => null);
  if (!fh) return null;
  let tail: string;
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, 16 * 1024));
    await fh.read(buf, 0, buf.length, size - buf.length);
    tail = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  const lines = tail
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  if (TOKEN_REFRESH_REJECTED.test(last))
    return {
      kind: "model_authentication_failed",
      message: "model login token refresh rejected (403 Forbidden)",
    };
  if (!RECONNECTING.test(last)) return null;
  const kind = lines
    .slice(-40)
    .reverse()
    .map((l) => (/\bERROR\b/.test(l) ? agentErrorKind(l) : null))
    .find((k) => k !== null);
  return {
    kind: kind ?? "model_unreachable",
    message: `stopped while reconnecting to the model: ${last}`,
  };
}
