import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRef, SessionMessage, SessionTranscript } from "../contracts/index.ts";
import { findClaudeSession, findCodexSession, sessionRoots } from "./files.ts";
import { projectTranscript } from "./projection.ts";
import {
  convertSessionFile,
  loadAgentTrajectory,
  readAgentEvidence,
  readTrajectory,
} from "./trajectory.ts";

export type { SessionRoots } from "./files.ts";
export { findClaudeSession, findCodexSession, runAgentSession, sessionRoots } from "./files.ts";
export { codexCallText, codexOutputText, projectTranscript } from "./projection.ts";

import { agentErrorKind } from "../harness/index.ts";

function clip(text: string, max: number): { text: string; truncated?: boolean } {
  return text.length <= max ? { text } : { text: text.slice(0, max), truncated: true };
}

export async function parseClaude(file: string): Promise<SessionMessage[]> {
  const result = await convertSessionFile(file, "claude-code");
  return result ? projectTranscript(result.trajectory, file).messages : [];
}

export async function parseCodex(file: string): Promise<SessionMessage[]> {
  const result = await convertSessionFile(file, "codex");
  return result ? projectTranscript(result.trajectory, file).messages : [];
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
  if (ref.harness === "claude-code") file = await findClaudeSession(roots, ref.sessionId);
  else if (ref.harness === "codex") file = (await findCodexSession(roots, ref))?.file ?? null;
  if (!file || (ref.harness !== "codex" && ref.harness !== "claude-code")) return null;
  const result = await convertSessionFile(file, ref.harness);
  return result ? projectTranscript(result.trajectory, file) : null;
}

/**
 * The session of an Agent that ran inside the run (its home is kept in the run directory as
 * `<agentDir>/codex` or `<agentDir>/claude`): the most recently written transcript.
 */
export async function loadRunAgentTranscript(agentDir: string): Promise<SessionTranscript | null> {
  const cached = await readTrajectory(join(agentDir, "..", "trajectory"));
  if (cached) return projectTranscript(cached);
  const result = await loadAgentTrajectory(agentDir);
  return result ? projectTranscript(result.trajectory, result.file) : null;
}

export interface AgentFailure {
  kind: string;
  message: string;
}

/**
 * An explicit final model error invalidates a run only if the session contains no successful
 * model response. Native config errors before session creation also identify failed setup.
 * Errors in user/tool content are ignored; partial model work is still scored.
 */
export async function runAgentFailure(
  agentDir: string,
  log?: string,
  redact: (text: string) => string = (text) => text,
): Promise<AgentFailure | null> {
  const source = await readAgentEvidence(agentDir);
  if (!source) {
    const failure = log ? await codexStartupFailure(agentDir, log) : null;
    return failure ? { ...failure, message: clip(redact(failure.message), 200).text } : null;
  }
  const { responded, open, text, code } = source.status;
  if (responded) return null;
  if (source.harness === "codex" && open && log) {
    const failure = await codexFailureAtEnd(log);
    return failure ? { ...failure, message: clip(redact(failure.message), 200).text } : null;
  }
  const kind = text !== null ? agentErrorKind(text, code) : null;
  return kind && text !== null
    ? { kind, message: clip(redact(text || "API error"), 200).text }
    : null;
}

/** A failed config read precedes Codex session creation; accept only its native startup output. */
async function codexStartupFailure(agentDir: string, log: string): Promise<AgentFailure | null> {
  if (!(await stat(join(agentDir, "codex", "config.toml")).catch(() => null))?.isFile())
    return null;
  const fh = await open(log, "r").catch(() => null);
  if (!fh) return null;
  let head: string;
  let complete: boolean;
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(size, 16 * 1024));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead).toString("utf8");
    complete = bytesRead === size;
  } finally {
    await fh.close();
  }
  const after = head.indexOf("\n[orbit] after phase output:\n");
  if (!complete && after < 0) return null;
  const lines = (after < 0 ? head : head.slice(0, after))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.pop();
  if (
    error !==
      "Error loading config.toml: Failed to read config file /orbit/agent/codex/config.toml: Permission denied (os error 13)" ||
    lines.some(
      (line) =>
        line !==
        "WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)",
    )
  )
    return null;
  return { kind: "agent_configuration_failed", message: error };
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

export type { TrajectoryConversion, TrajectoryMedia, TrajectoryOptions } from "./atif.ts";
export type { ClaudeTrajectoryOptions } from "./claude.ts";
export { convertClaudeTrajectory } from "./claude.ts";
export type { CodexTrajectoryOptions } from "./codex.ts";
export { convertCodexTrajectory } from "./codex.ts";
