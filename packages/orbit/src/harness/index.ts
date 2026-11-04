import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { type AuthEntry, parseCodexLogin, secretValues } from "../auth/index.ts";
import type { AgentDefinition, Method } from "../contracts/index.ts";
import { preserveCodexMcp } from "./mcp.ts";
import { AgentError, type HostCli, renderCommand } from "./registry.ts";

export { BUILTIN_SEEDS } from "./definitions.ts";
export { AgentError, type HostCli } from "./registry.ts";

/** Where the Agent home lives inside the container (under the `/orbit` mount). */
export const AGENT_HOME = "/orbit/agent";

/** Translate the declared container home into its host directory. */
export function agentHomeDir(def: AgentDefinition, agentDir: string): string {
  const path = relative(AGENT_HOME, def.auth.home ?? `${AGENT_HOME}/${def.name}`);
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path))
    throw new AgentError(`${def.name}: Agent home must be below ${AGENT_HOME}`);
  return join(agentDir, path);
}

/**
 * Kept for callers that still say "harness"; an Agent is what Orbit drives, and its definition
 * (`contracts/agent.ts`) says how.
 */
export class HarnessError extends AgentError {}

export interface Prepared {
  mounts: { source: string; target: string; mode: "ro" }[];
  /** Non-secret environment. */
  env: Record<string, string>;
  /** Secret environment, passed through a private `--env-file`. */
  secretEnv: Record<string, string>;
  /** Strings to redact from logs. */
  secrets: string[];
  /** The host CLI when the definition mounts one; null for install/image Agents. */
  cli: HostCli | null;
  /** Shell command the run executes before the Agent (`install` installs). */
  setup: string | null;
}

const tomlString = (s: string) => JSON.stringify(s);

/** Codex config: the container is the sandbox, so Codex itself runs without approvals or sandboxing. */
export function codexConfig(entry: AuthEntry): string {
  const p = entry.profile;
  const lines = ['approval_policy = "never"', 'sandbox_mode = "danger-full-access"'];
  if (p.model) lines.push(`model = ${tomlString(p.model)}`);
  if (p.kind === "relay") {
    lines.push(
      'model_provider = "orbit"',
      "",
      "[model_providers.orbit]",
      'name = "Orbit relay"',
      `base_url = ${tomlString(p.baseUrl ?? "")}`,
      'env_key = "ORBIT_RELAY_API_KEY"',
      'wire_api = "responses"',
    );
  }
  return `${lines.join("\n")}\n`;
}

function writePrivate(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Fill `{model}`, `{baseUrl}` and `{home}` in a definition's declared environment. */
function agentEnv(def: AgentDefinition, entry: AuthEntry, home: string): Record<string, string> {
  const p = entry.profile;
  const fill = (v: string) =>
    v
      .replace(/\{model\}/g, p.model ?? "")
      .replace(/\{baseUrl\}/g, p.baseUrl ?? "")
      .replace(/\{home\}/g, home);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.auth.env)) env[k] = fill(v);
  if (def.auth.homeEnv && def.auth.home) env[def.auth.homeEnv] = home;
  if (def.auth.baseUrlEnv && p.baseUrl) env[def.auth.baseUrlEnv] = p.baseUrl;
  if (def.auth.modelEnv && p.model) env[def.auth.modelEnv] = p.model;
  return env;
}

/**
 * Prepare an Agent for a run: the home directory (mounted at /orbit/agent, kept with the run), the
 * credentials and environment the definition declares, and the host CLI when it mounts one.
 *
 * The two built-ins keep their own config writers (Codex's config.toml, Claude Code's relay
 * aliases); every other Agent is driven only by its definition.
 */
export async function prepareAgent(
  def: AgentDefinition,
  entry: AuthEntry,
  agentDir: string,
  opts: { hostCli: (def: AgentDefinition) => Promise<HostCli | null> },
): Promise<Prepared> {
  const p = entry.profile;
  if (!def.auth.kinds.includes(p.kind))
    throw new HarnessError(`${def.name} does not support ${p.kind} auth profiles`);
  // The built-ins' login flows write a credential file instead of setting a variable; every other
  // Agent passes its secret through the variable its definition names.
  const builtinLogin = (def.name === "codex" || def.name === "claude-code") && p.kind === "login";
  const declared = def.auth.secretEnv[p.kind];
  if (!declared && !builtinLogin)
    throw new HarnessError(`${def.name} has no ${p.kind} secret variable`);

  const dir = agentHomeDir(def, agentDir);
  mkdirSync(dir, { recursive: true });
  const home = def.auth.home ?? `${AGENT_HOME}/${def.name}`;
  const env: Record<string, string> = { ...p.env, DISABLE_AUTOUPDATER: "1" };
  const secretEnv: Record<string, string> = {};
  let setup: string | null = null;
  let cli: HostCli | null = null;

  if (def.name === "codex") {
    env.CODEX_HOME = home;
    const config = join(dir, "config.toml");
    writePrivate(
      config,
      preserveCodexMcp(codexConfig(entry), existsSync(config) ? readFileSync(config, "utf8") : ""),
    );
    if (p.kind === "login") writePrivate(join(dir, "auth.json"), entry.secret);
    else if (p.kind === "api-key")
      writePrivate(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: entry.secret }));
    else secretEnv.ORBIT_RELAY_API_KEY = entry.secret;
  } else if (def.name === "claude-code") {
    env.CLAUDE_CONFIG_DIR = home;
    // As Harbor's claude-code agent: root containers refuse to skip permissions without IS_SANDBOX.
    env.IS_SANDBOX = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (p.model) env.ANTHROPIC_MODEL = p.model;
    if (p.kind === "login") secretEnv.CLAUDE_CODE_OAUTH_TOKEN = entry.secret;
    else if (p.kind === "api-key") secretEnv.ANTHROPIC_API_KEY = entry.secret;
    else {
      env.ANTHROPIC_BASE_URL = p.baseUrl ?? "";
      secretEnv.ANTHROPIC_AUTH_TOKEN = entry.secret;
      // A relay serves one model: Claude Code's tier aliases and subagents use it too (as Harbor).
      if (p.model) for (const k of RELAY_MODEL_VARS) if (!(k in (p.env ?? {}))) env[k] = p.model;
    }
  } else {
    Object.assign(env, agentEnv(def, entry, home));
    if (declared) secretEnv[declared] = entry.secret;
  }

  const mounts: Prepared["mounts"] = [];
  if (def.install.kind === "host") {
    cli = await opts.hostCli(def);
    if (!cli)
      throw new HarnessError(
        `${def.name} not found on the daemon's PATH${def.install.pathEnv ? ` (set ${def.install.pathEnv})` : ""}`,
      );
    mounts.push({ source: cli.source, target: cli.target, mode: "ro" });
  } else if (def.install.kind === "install") {
    setup = def.install.script;
    // Global npm installs go to the Agent home, which the (non-root) run user can write.
    env.NPM_CONFIG_PREFIX = `${home}/.prefix`;
  }

  return { mounts, env, secretEnv, secrets: secretValues(entry), cli, setup };
}

const RELAY_MODEL_VARS = [
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/** Credential files an Agent may leave in its home; removed after the run. */
const CREDENTIAL_FILES = ["codex/auth.json", "claude/.credentials.json"];
/** Files another Agent's CLI may write its own key into, below its home. */
const GENERIC_CREDENTIALS = [
  ".credentials.json",
  "auth.json",
  "credentials.json",
  "oauth_creds.json",
];

/**
 * After a run: return a refreshed Codex login (newer `last_refresh`) to write back, and delete
 * credential files from the Agent home. The rest of the home (sessions, logs) stays with the run.
 */
export function finishHarness(
  entry: AuthEntry | null,
  agentDir: string,
  def?: AgentDefinition | null,
): { refreshed?: string } {
  const out: { refreshed?: string } = {};
  if (entry?.profile.harness === "codex" && entry.profile.kind === "login") {
    const file = join(agentDir, "codex", "auth.json");
    try {
      const text = readFileSync(file, "utf8");
      const now = parseCodexLogin(text);
      const before = parseCodexLogin(entry.secret);
      if ((now.last_refresh ?? "") > (before.last_refresh ?? "")) out.refreshed = text;
    } catch {}
  }
  for (const f of CREDENTIAL_FILES) rmSync(join(agentDir, f), { force: true });
  // Clear obvious key files in the registered Agent's declared home too.
  if (def)
    for (const f of GENERIC_CREDENTIALS)
      rmSync(join(agentHomeDir(def, agentDir), f), { force: true });
  return out;
}

/** `PATH` for the container: Agent directories first, then the image's own PATH. */
export function containerPath(pathDirs: string[], imagePath: string | null): string {
  const base = imagePath || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return [...pathDirs, base].join(":");
}

/**
 * Headless Agent invocation for a method: argv from the Agent's definition, so a new CLI needs no
 * code here. `home` is where the run's Agent home is mounted inside the container.
 */
export function agentCommand(
  def: AgentDefinition,
  method: Method,
  instruction: string,
  mcp = false,
): string[] {
  if (!def.command.run) throw new HarnessError(`${def.name} cannot run an instruction`);
  return renderCommand(def, "run", {
    instruction,
    mcp,
    model: method.model,
    effort: method.effort,
    home: def.auth.home ?? `${AGENT_HOME}/${def.name}`,
  });
}

/** Continuation of a session: the Agent's `resume` template, or an error when it has none. */
export function resumeAgentCommand(
  def: AgentDefinition,
  method: Pick<Method, "model" | "effort">,
  session: { sessionId: string },
  mcp = false,
): string[] {
  if (!def.command.resume)
    throw new HarnessError(`${def.name} cannot continue a session; provide a command instead`);
  return renderCommand(def, "resume", {
    mcp,
    instruction:
      "Continue the interrupted task from the saved state. Inspect existing files and avoid repeating completed work.",
    model: method.model,
    effort: method.effort,
    session: session.sessionId,
    home: def.auth.home ?? `${AGENT_HOME}/${def.name}`,
  });
}

/**
 * Why an Agent CLI could not do the work, from its structured error code when it has one, else its
 * error text: credentials, model access, quota or the model endpoint. Null for anything else (a
 * failing experiment is the method's result).
 */
export function agentErrorKind(text: string, code?: unknown): string | null {
  const structured = agentErrorCodeKind(code);
  if (structured) return structured;
  const t = text.toLowerCase();
  if (
    /invalid_api_key|authentication_error|unauthorized|token_revoked|invalidated oauth token|oauth token has expired|invalid api key|please run \/login|missing bearer/.test(
      t,
    )
  )
    return "model_authentication_failed";
  if (
    /usage limit|hit your limit|insufficient_quota|exceeded your current quota|credit balance is too low|rate_limit_error|last status: 429/.test(
      t,
    )
  )
    return "model_quota_exhausted";
  if (
    t.includes("model") &&
    /not supported|does not exist|may not exist|do not have access|model_not_found|at capacity/.test(
      t,
    )
  )
    return "model_unavailable";
  if (/overloaded_error|internal server error|api error: 5\d\d/.test(t)) return "model_unavailable";
  if (
    /stream disconnected|error sending request|connection (reset|refused|failed|error)|workspace routing discovery|waiting for network|exceeded retry limit|request timed out|unable to connect to api|econnrefused|econnreset|enotfound|etimedout/.test(
      t,
    )
  )
    return "model_unreachable";
  return null;
}

const STATUS_KINDS: Record<string, string> = {
  "401": "model_authentication_failed",
  "403": "model_authentication_failed",
  "404": "model_unavailable",
  "429": "model_quota_exhausted",
};

/**
 * The structured error code an Agent CLI records with its final error: Codex's `codex_error_info`
 * (a name, or `{ <name>: { http_status_code } }`) or Claude Code's assistant `error`. Codes that do
 * not tell (bad requests, context overflow, `other`) leave the decision to the message.
 */
function agentErrorCodeKind(code: unknown): string | null {
  if (typeof code === "string")
    return (
      {
        unauthorized: "model_authentication_failed",
        authentication_failed: "model_authentication_failed",
        usage_limit_exceeded: "model_quota_exhausted",
        billing_error: "model_quota_exhausted",
        rate_limit: "model_quota_exhausted",
        server_overloaded: "model_unavailable",
        internal_server_error: "model_unavailable",
        server_error: "model_unavailable",
      }[code] ?? null
    );
  if (!code || typeof code !== "object") return null;
  const [name, detail] = Object.entries(code)[0] ?? [];
  if (
    !name ||
    ![
      "http_connection_failed",
      "response_stream_connection_failed",
      "response_stream_disconnected",
      "response_too_many_failed_attempts",
    ].includes(name)
  )
    return null;
  const status = (detail as { http_status_code?: unknown } | null)?.http_status_code;
  if (typeof status !== "number" || status >= 500) return "model_unreachable";
  return STATUS_KINDS[String(status)] ?? null;
}
