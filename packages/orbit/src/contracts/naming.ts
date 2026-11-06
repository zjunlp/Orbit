// Display names of runs without a name: a fixed rule over the command (no model involved), shared by
// the CLI and the Web UI. The stored run keeps its name empty and its full command. No imports, so
// the Web bundle can use it at runtime (`@zjunlp/orbit/naming`).

const MAX = 60;

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isPython = (t: string) => /^python[\d.]*$/.test(base(t));
/** Script interpreters followed by a script file. */
const INTERPRETERS = new Set([
  "node",
  "bun",
  "deno",
  "Rscript",
  "julia",
  "perl",
  "ruby",
  "bash",
  "sh",
]);
/** Prefixes that only change how the real command starts. */
const WRAPPERS = new Set(["env", "nohup", "time", "exec", "stdbuf", "nice", "ionice"]);
/** Launchers whose own options come before the program. */
const LAUNCHERS = new Set(["torchrun", "deepspeed", "mpirun", "srun", "horovodrun"]);
/** `<tool> run|launch <program>` style launchers. */
const SUBCOMMAND_LAUNCHERS: Record<string, string[]> = {
  uv: ["run"],
  poetry: ["run"],
  pipenv: ["run"],
  pdm: ["run"],
  conda: ["run"],
  accelerate: ["launch"],
  npx: [],
  pnpm: ["exec", "dlx"],
};
/** Python options that take a value. */
const PY_VALUE_OPTS = new Set(["-W", "-X", "--check-hash-based-pycs"]);
const SHELL_SETUP = /^(cd|export|source|\.|set|ulimit|mkdir|echo|true|:|unset|umask)$/;

/** Split a shell command string into words (quotes and backslashes; no expansion). */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** The last real command of a `sh -c` script: `cd x && python y` → `python y`. */
function fromScript(script: string): string[] {
  const parts = script
    .split(/&&|\|\||;|\n|\|/)
    .map((p) => shellWords(p.trim()))
    .filter((w) => w.length > 0 && !SHELL_SETUP.test(w[0] as string));
  return parts.at(-1) ?? [];
}

const SCRIPT = /\.(py|sh|js|ts|R|jl|rb|pl)$/;

/**
 * Skip `--opt value` / `--opt=value` / `-o` options of a launcher up to its program; stops at
 * `-m` / `--module` (the program is a Python module). A word ending like a script is the program.
 */
function skipOptions(t: string[], i: number): number {
  while (i < t.length && (t[i] as string).startsWith("-")) {
    const o = t[i] as string;
    if (o === "-m" || o === "--module") return i;
    i += 1;
    const next = t[i];
    if (
      !o.includes("=") &&
      next !== undefined &&
      !next.startsWith("-") &&
      !SCRIPT.test(next) &&
      i + 1 < t.length
    )
      i += 1;
  }
  return i;
}

/**
 * Argument words worth showing: leading subcommand words (`run`, `exec`), then `key=value`,
 * `--flag value` and `--flag=value` as `flag=value`. Bare flags and positional values are left out.
 */
function argWords(rest: string[]): string[] {
  const out: string[] = [];
  let lead = 0;
  while (lead < 2 && /^[A-Za-z][\w-]{0,19}$/.test(rest[lead] ?? ""))
    out.push(rest[lead++] as string);
  rest = rest.slice(lead);
  // Paths and prose (prompts) are not parameters.
  const keep = (v: string) =>
    v !== "" && v.length <= 40 && !/\s/.test(v) && !v.startsWith("/") && !v.startsWith("~");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        const v = a.slice(eq + 1);
        if (keep(v)) out.push(`${a.slice(2, eq)}=${v}`);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        if (keep(next)) out.push(`${a.slice(2)}=${next}`);
        i += 1;
      }
    } else if (/^[A-Za-z_][\w.-]*=/.test(a)) {
      const v = a.slice(a.indexOf("=") + 1);
      if (keep(v)) out.push(a);
    }
  }
  return out;
}

function clip(s: string): string {
  return s.length <= MAX ? s : `${s.slice(0, MAX - 1)}…`;
}

/**
 * A short name for a command: launchers and interpreters dropped, the script or module name, then
 * `key=value` arguments (path values left out), at most 60 characters. Falls back to the clipped
 * command when no program is recognized (e.g. `python -c ...`).
 */
export function autoRunName(command: string[]): string {
  const fallback = clip(command.join(" "));
  let t = [...command];
  for (let guard = 0; guard < 8 && t.length; guard++) {
    const head = t[0] as string;
    const name = base(head);
    if ((name === "sh" || name === "bash" || name === "zsh") && /^-\w*c$/.test(t[1] ?? "")) {
      t = fromScript(t[2] ?? "");
      continue;
    }
    if (WRAPPERS.has(name)) {
      let i = 1;
      while (i < t.length && (/^\w+=/.test(t[i] as string) || (t[i] as string).startsWith("-")))
        i += 1;
      t = t.slice(i);
      continue;
    }
    if (/^[A-Za-z_]\w*=/.test(head)) {
      t = t.slice(1);
      continue;
    }
    if (LAUNCHERS.has(name)) {
      t = t.slice(skipOptions(t, 1));
      if (t[0] === "-m" || t[0] === "--module") t = ["python", "-m", ...t.slice(1)];
      continue;
    }
    const sub = SUBCOMMAND_LAUNCHERS[name];
    if (sub) {
      let i = 1;
      if (sub.length && sub.includes(t[1] ?? "")) i = 2;
      else if (sub.length) break;
      t = t.slice(skipOptions(t, i));
      if (t[0] === "-m" || t[0] === "--module") t = ["python", "-m", ...t.slice(1)];
      continue;
    }
    break;
  }
  if (!t.length) return fallback;
  let subject: string | null = null;
  let rest: string[] = [];
  const head = t[0] as string;
  if (isPython(head)) {
    let i = 1;
    while (i < t.length && (t[i] as string).startsWith("-")) {
      const o = t[i] as string;
      if (o === "-m") {
        subject = t[i + 1] ?? null;
        rest = t.slice(i + 2);
        break;
      }
      if (o === "-c") return fallback;
      i += PY_VALUE_OPTS.has(o) ? 2 : 1;
    }
    if (!subject && i < t.length) {
      subject = base(t[i] as string);
      rest = t.slice(i + 1);
    }
    // `python -m torch.distributed.run ... train.py`: the launcher's program is the subject.
    if (subject === "torch.distributed.run" || subject === "torch.distributed.launch") {
      let j = skipOptions(rest, 0);
      if (rest[j] === "-m" || rest[j] === "--module") j += 1;
      if (j < rest.length) {
        subject = base(rest[j] as string);
        rest = rest.slice(j + 1);
      }
    }
  } else if (INTERPRETERS.has(base(head)) && t[1] && !t[1].startsWith("-")) {
    subject = base(t[1]);
    rest = t.slice(2);
  } else {
    subject = base(head);
    rest = t.slice(1);
  }
  if (!subject) return fallback;
  return clip([subject, ...argWords(rest)].join(" "));
}

/** The name a run is shown under: its own name, else one derived from its command. */
export function runDisplayName(spec: { name?: string; command: string[] }): string {
  return spec.name || autoRunName(spec.command);
}

export function sampleLabel(value: { seed?: number; sampleRef?: string }): string {
  return value.sampleRef ? value.sampleRef.slice(7, 19) : String(value.seed);
}

export function sampleOrder(
  a: { seed?: number; sampleRef?: string },
  b: { seed?: number; sampleRef?: string },
): number {
  return a.sampleRef || b.sampleRef
    ? (a.sampleRef ?? String(a.seed)).localeCompare(b.sampleRef ?? String(b.seed))
    : (a.seed ?? 0) - (b.seed ?? 0);
}
