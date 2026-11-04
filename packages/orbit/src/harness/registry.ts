import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentInfo,
  BUILTIN_AGENTS,
  RESERVED_METHOD_AGENTS,
  AgentDefinition as schema,
} from "../contracts/index.ts";
import { exec } from "../lib/exec.ts";
import { writePrivateJson } from "../lib/private-json.ts";
import { BUILTIN_SEEDS, definitionProblem, renderTemplate } from "./definitions.ts";

export class AgentError extends Error {}

/** Where an Agent CLI lives on the daemon's machine, and how it reaches a container. */
export interface HostCli {
  name: string;
  /** Host path mounted read-only (a binary or a directory). */
  source: string;
  /** The executable on the host (for `--version`). */
  hostBin: string;
  /** Container path of the mount. */
  target: string;
  /** Directories inside the container to put on PATH. */
  pathDirs: string[];
  /** Also mount the daemon's Node runtime, replacing its own path with a shim. */
  node?: string;
  version: string;
}

function which(cmd: string, env: NodeJS.ProcessEnv): string | null {
  if (cmd.startsWith("/")) return existsSync(cmd) ? cmd : null;
  for (const d of (env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, cmd);
    try {
      if (statSync(p).isFile()) return realpathSync(p);
    } catch {}
  }
  return null;
}

/** Find a directory containing `codex-package.json` (the npm vendor layout) below `root`. */
function findCodexVendor(root: string, depth = 6): string | null {
  if (existsSync(join(root, "codex-package.json"))) return root;
  if (depth === 0) return null;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const n of names) {
    const p = join(root, n);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = findCodexVendor(p, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** The daemon's Node executable, for CLIs that are Node scripts and for images without Node. */
export function hostNode(env: NodeJS.ProcessEnv = process.env): string | null {
  return realpathSync(process.execPath) ?? (which("node", env) as string | null);
}

/**
 * Locate the Codex CLI on the host. Codex ships a static musl binary, so it runs in any Linux image.
 * `ORBIT_CODEX_DIR` may point at the vendor directory (with `codex-package.json`) or a `codex` binary.
 */
export function locateCodex(env: NodeJS.ProcessEnv = process.env): Omit<HostCli, "version"> | null {
  const override = env.ORBIT_CODEX_DIR;
  const start = override ?? which("codex", env);
  if (!start || !existsSync(start)) return null;
  if (statSync(start).isFile() && !start.endsWith(".js")) {
    return {
      name: "codex",
      source: start,
      hostBin: start,
      target: "/opt/orbit/codex/bin/codex",
      pathDirs: ["/opt/orbit/codex/bin"],
    };
  }
  // npm install: <pkg>/bin/codex.js with the binary in <pkg>/node_modules/@openai/codex-<platform>/vendor/<triple>.
  const pkg = statSync(start).isDirectory() ? start : dirname(dirname(start));
  const vendor = findCodexVendor(pkg);
  if (!vendor) return null;
  const meta = JSON.parse(readFileSync(join(vendor, "codex-package.json"), "utf8")) as {
    entrypoint?: string;
    pathDir?: string;
  };
  const entry = meta.entrypoint ?? "bin/codex";
  return {
    name: "codex",
    source: vendor,
    hostBin: join(vendor, entry),
    target: "/opt/orbit/codex",
    pathDirs: [
      join("/opt/orbit/codex", dirname(entry)),
      ...(meta.pathDir ? [join("/opt/orbit/codex", meta.pathDir)] : []),
    ],
  };
}

/** Locate the native Claude Code binary (needs glibc in the image). `ORBIT_CLAUDE_BIN` overrides. */
export function locateClaude(
  env: NodeJS.ProcessEnv = process.env,
): Omit<HostCli, "version"> | null {
  const bin = env.ORBIT_CLAUDE_BIN ?? which("claude", env);
  if (!bin || !existsSync(bin) || bin.endsWith(".js") || bin.endsWith(".cjs")) return null;
  return {
    name: "claude-code",
    source: bin,
    hostBin: bin,
    target: "/opt/orbit/claude/claude",
    pathDirs: ["/opt/orbit/claude"],
  };
}

/**
 * A `host` install: what to mount. A binary that is a Node script needs the daemon's Node, so the
 * mount carries the script and a `node` shim pointing at the mounted runtime.
 */
export function locateHost(
  def: AgentDefinition,
  env: NodeJS.ProcessEnv = process.env,
): Omit<HostCli, "version"> | null {
  if (def.install.kind !== "host") return null;
  if (def.name === "codex") return locateCodex(env);
  if (def.name === "claude-code") return locateClaude(env);
  const install = def.install;
  const bin = (install.pathEnv ? env[install.pathEnv] : undefined) ?? which(install.binary, env);
  if (!bin || !existsSync(bin)) return null;
  const node = install.withNode ? hostNode(env) : null;
  return {
    name: def.name,
    source: bin,
    hostBin: bin,
    target: join(install.mount, install.binary),
    pathDirs: install.pathDirs ?? [install.mount],
    ...(node ? { node } : {}),
  };
}

/** Built-ins carry their own origin/verified flags; the seeds are the same data without them. */
function builtins(): AgentDefinition[] {
  return BUILTIN_SEEDS.map(
    (a) =>
      schema.parse({
        ...a,
        origin: "builtin",
        verified: a.name === "codex" || a.name === "claude-code",
      }) as AgentDefinition,
  );
}

interface AgentsFile {
  version: 1;
  agents: AgentDefinitionInput[];
}

/**
 * Agent definitions known on this node: the built-ins plus user definitions stored in
 * `<home>/agents.json` (0600). User definitions may not shadow a built-in name.
 */
export class AgentRegistry {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private cached: { mtimeMs: number; user: AgentDefinitionInput[] } | null = null;

  constructor(file: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = file;
    this.env = env;
  }

  private user(): AgentDefinitionInput[] {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      return [];
    }
    if (this.cached?.mtimeMs === mtimeMs) return this.cached.user;
    let agents: AgentDefinitionInput[] = [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as AgentsFile;
      agents = (raw.agents ?? []).map(
        (a) =>
          schema.omit({ origin: true, verified: true }).strip().parse(a) as AgentDefinitionInput,
      );
    } catch {
      agents = [];
    }
    this.cached = { mtimeMs, user: agents };
    return agents;
  }

  private writeUser(agents: AgentDefinitionInput[]): void {
    writePrivateJson(this.file, { version: 1, agents } satisfies AgentsFile);
    this.cached = null;
  }

  list(): AgentDefinition[] {
    const user = this.user()
      .filter((a) => !(BUILTIN_AGENTS as readonly string[]).includes(a.name))
      .map((a) => schema.parse({ ...a, origin: "user", verified: false }) as AgentDefinition);
    return [...builtins(), ...user].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): AgentDefinition | null {
    return this.list().find((a) => a.name === name) ?? null;
  }

  /** Built-ins cannot be replaced; a user definition with the same name is rejected. */
  put(input: AgentDefinitionInput): AgentDefinition {
    const parsed = schema
      .omit({ origin: true, verified: true })
      .parse(input) as AgentDefinitionInput;
    if ((BUILTIN_AGENTS as readonly string[]).includes(parsed.name))
      throw new AgentError(`${parsed.name} is built in and cannot be replaced`);
    if ((RESERVED_METHOD_AGENTS as readonly string[]).includes(parsed.name))
      throw new AgentError(`${parsed.name} is a reserved method kind, not an Agent name`);
    const problem = definitionProblem(parsed);
    if (problem) throw new AgentError(problem);
    const home = parsed.auth?.home;
    if (
      home !== undefined &&
      (!/^\/orbit\/agent\/[^/]/.test(home) || home.split("/").includes(".."))
    )
      throw new AgentError(`${parsed.name}: auth.home must be a directory below /orbit/agent`);
    const agents = [...this.user().filter((a) => a.name !== parsed.name), parsed].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    this.writeUser(agents);
    return this.get(parsed.name) as AgentDefinition;
  }

  remove(name: string): boolean {
    if ((BUILTIN_AGENTS as readonly string[]).includes(name))
      throw new AgentError(`${name} is built in and cannot be removed`);
    const before = this.user();
    const after = before.filter((a) => a.name !== name);
    if (after.length === before.length) return false;
    this.writeUser(after);
    return true;
  }

  /** Where the CLI is on this node, with its version (cached for the daemon's lifetime). */
  host(def: AgentDefinition): Promise<HostCli | null> {
    if (def.install.kind !== "host") return Promise.resolve(null);
    const key = def.name;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const p: Promise<HostCli | null> = (async () => {
      const loc = locateHost(def, this.env);
      if (!loc) return null;
      const r = await exec(loc.hostBin, ["--version"]);
      const version = r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "unknown") : "unknown";
      return { ...loc, version };
    })();
    this.cache.set(key, p);
    void p.then((v) => v ?? this.cache.delete(key));
    return p;
  }

  /** Whether this node could run the Agent: a host CLI is present, or it installs inside the run. */
  async info(def: AgentDefinition): Promise<AgentInfo> {
    if (def.install.kind === "host") {
      const cli = await this.host(def);
      return {
        definition: def,
        available: Boolean(cli),
        detail: cli
          ? `${cli.version} (${cli.hostBin})`
          : def.install.pathEnv
            ? `not found on the daemon's PATH (set ${def.install.pathEnv})`
            : "not found on the daemon's PATH",
        version: cli?.version ?? null,
      };
    }
    if (def.install.kind === "image") {
      return {
        definition: def,
        available: true,
        detail: "provided by the task image",
        version: null,
      };
    }
    return {
      definition: def,
      available: true,
      detail: `installed in the run with: ${def.install.script.slice(0, 80)}`,
      version: null,
    };
  }

  private cache = new Map<string, Promise<HostCli | null>>();
}

/**
 * Built-ins only, for callers without a daemon home (tests, one-off CLI paths). The daemon passes
 * its own registry so user definitions are visible.
 */
export function builtinRegistry(): AgentRegistry {
  return new AgentRegistry("/nonexistent/orbit-agents.json");
}

/** argv for one instruction (`run`) or its continuation (`resume`), with optional flags dropped. */
export function renderCommand(
  def: AgentDefinition,
  phase: "run" | "resume",
  vars: {
    instruction: string;
    model?: string;
    effort?: string;
    session?: string;
    home: string;
    mcp?: boolean;
  },
): string[] {
  const tokens = phase === "resume" ? def.command.resume : def.command.run;
  if (!tokens) throw new AgentError(`${def.name} cannot continue a session`);
  const mcp = def.command.mcp;
  const configured =
    vars.mcp && mcp.kind === "claude-json"
      ? tokens.flatMap((t) =>
          // Claude's variadic config option otherwise consumes the following instruction.
          t.includes("{instruction}") ? [`${mcp.flag}=${vars.home}/orbit-mcp.json`, t] : [t],
        )
      : tokens;
  const argv = renderTemplate(configured, {
    instruction: vars.instruction,
    model: vars.model,
    effort: vars.effort,
    session: vars.session,
    home: vars.home,
  });
  if (argv.some((a) => a.includes("{instruction}") || a.includes("{model}")))
    throw new AgentError(`${def.name}: unrendered placeholder in ${phase} command`);
  return argv;
}
