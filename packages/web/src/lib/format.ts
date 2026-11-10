import { runDisplayName } from "@zjunlp/orbit/naming";
import type { Run, RunState } from "./api.ts";

export const STATE_LABEL: Record<RunState, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  lost: "Lost",
};

export const STATES: RunState[] = [
  "running",
  "starting",
  "queued",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
];

/** In-app paths; ids are encoded so any id survives the URL. */
export const runPath = (id: string) => `/runs/${encodeURIComponent(id)}`;
export const jobPath = (id: string) => `/bench/${encodeURIComponent(id)}`;
export const trialPath = (jobId: string, trialId: string) =>
  `${jobPath(jobId)}/trials/${encodeURIComponent(trialId)}`;

export const isActive = (s: RunState) => s === "queued" || s === "starting" || s === "running";

/** 3.2s, 4m 05s, 2h 13m, 3d 4h */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function runDuration(r: Run, now = Date.now()): number | null {
  if (!r.startedAt) return null;
  return (r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt);
}

export function queuedFor(r: Run, now = Date.now()): number {
  return (
    (r.startedAt ? Date.parse(r.startedAt) : r.endedAt ? Date.parse(r.endedAt) : now) -
    Date.parse(r.createdAt)
  );
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const d = (Date.parse(iso) - now) / 1000;
  const a = Math.abs(d);
  if (a < 45) return "just now";
  if (a < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(d / 3600), "hour");
  if (a < 86400 * 30) return rtf.format(Math.round(d / 86400), "day");
  return new Date(iso).toLocaleDateString();
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour12: false })}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** Compact numbers for metric tables: 4 significant digits, scientific for tiny/huge. */
export function num(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return Number(v.toPrecision(4)).toString();
}

/** The run's name, else a short name derived from its command (same rule as the CLI). */
export function runTitle(r: Run): string {
  return runDisplayName(r.spec);
}

export function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

/** Shell-quote argv for copyable commands. */
export function shellQuote(args: string[]): string {
  return args
    .map((a) => (/^[\w@%+=:,./{}-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}

/** The `orbit run` invocation that reproduces a run's spec. */
export function cliCommand(r: Run): string {
  const s = r.spec;
  const a: string[] = ["orbit", "run"];
  if (s.name) a.push("-n", s.name);
  if (s.group) a.push("-g", s.group);
  if (s.project) a.push("--project", s.project);
  else a.push("--no-project");
  if (s.image) a.push("--image", s.image);
  if (s.dockerfile) a.push("--dockerfile", s.dockerfile);
  const res = s.resources;
  if (res.gpus) a.push("--gpus", String(res.gpus));
  if (res.gpuMemGB) a.push("--gpu-mem", String(res.gpuMemGB));
  a.push("--cpus", String(res.cpus), "--mem", String(res.memGB));
  for (const m of s.mounts) {
    const rw = m.mode === "rw" ? ":rw" : "";
    if (m.dataset) a.push("-d", `${m.dataset}:${m.target}${rw}`);
    else a.push("-m", `${m.source}:${m.target}${rw}`);
  }
  if (s.resources.node) a.push("--node", s.resources.node);
  for (const [k, v] of Object.entries(s.env)) a.push("-e", `${k}=${v}`);
  if (!s.network) a.push("--no-network");
  else if (s.hostNetwork) a.push("--host-network");
  if (s.auth) a.push("--auth", s.auth);
  if (!s.snapshot) a.push("--no-snapshot");
  if (s.root) a.push("--root");
  if (s.commandUser) a.push("--command-user", s.commandUser);
  if (s.timeoutMin) a.push("--timeout", String(s.timeoutMin));
  for (const [k, v] of Object.entries(s.tags)) a.push("-t", `${k}=${v}`);
  a.push("--", ...s.command);
  return shellQuote(a);
}

export function harnessLabel(h: string): string {
  return h === "claude-code" ? "Claude Code" : h === "codex" ? "Codex" : h;
}

/** A score for display: at most two decimals, trailing zeros dropped. */
export function fmtScore(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return String(Math.round(v * 100) / 100);
}
