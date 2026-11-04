import type { AgentDefinitionInput } from "../contracts/index.ts";

/**
 * Agent definitions that ship with Orbit. `codex` and `claude-code` are built by code that knows
 * their config files; the rest are pure data, driven by Orbit's generic launcher.
 *
 * Flags, install commands and transcript locations follow the agents' own CLIs (cross-checked
 * against Harbor's adapters at `f6cf2e2`, 2026-11-03). None of these have been run on this machine,
 * so they stay `verified: false` until `orbit agent test` says otherwise.
 */

const npm = (pkg: string, version = "latest") =>
  `command -v node >/dev/null 2>&1 || { echo "node is required to install ${pkg}" >&2; exit 1; }; npm install -g --ignore-scripts ${pkg}@${version}`;

export const BUILTIN_SEEDS: AgentDefinitionInput[] = [
  {
    name: "codex",
    description: "OpenAI Codex CLI (host binary, static musl)",
    install: {
      kind: "host",
      binary: "codex",
      mount: "/opt/orbit/codex",
      pathEnv: "ORBIT_CODEX_DIR",
    },
    auth: {
      kinds: ["login", "api-key", "relay"],
      secretEnv: { "api-key": "OPENAI_API_KEY", relay: "ORBIT_RELAY_API_KEY" },
      home: "/orbit/agent/codex",
      homeEnv: "CODEX_HOME",
    },
    command: {
      run: [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "{when:model}",
        "--model",
        "{model}",
        "{end}",
        "{when:effort}",
        "-c",
        "model_reasoning_effort={effort}",
        "{end}",
        "{instruction}",
      ],
      resume: [
        "codex",
        "exec",
        "resume",
        "{session}",
        "{when:model}",
        "--model",
        "{model}",
        "{end}",
        "{when:effort}",
        "-c",
        "model_reasoning_effort={effort}",
        "{end}",
        "{instruction}",
      ],
      transcript: { glob: "sessions/**/*.jsonl", format: "codex" },
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "claude-code",
    description: "Anthropic Claude Code (host binary)",
    install: {
      kind: "host",
      binary: "claude",
      mount: "/opt/orbit/claude",
      pathEnv: "ORBIT_CLAUDE_BIN",
    },
    auth: {
      kinds: ["login", "api-key", "relay"],
      secretEnv: {
        login: "CLAUDE_CODE_OAUTH_TOKEN",
        "api-key": "ANTHROPIC_API_KEY",
        relay: "ANTHROPIC_AUTH_TOKEN",
      },
      home: "/orbit/agent/claude",
      homeEnv: "CLAUDE_CONFIG_DIR",
    },
    command: {
      run: [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "{when:model}",
        "--model",
        "{model}",
        "{end}",
        "{when:effort}",
        "--effort",
        "{effort}",
        "{end}",
        "{instruction}",
      ],
      resume: [
        "claude",
        "-p",
        "--resume",
        "{session}",
        "{when:model}",
        "--model",
        "{model}",
        "{end}",
        "{when:effort}",
        "--effort",
        "{effort}",
        "{end}",
        "{instruction}",
      ],
      transcript: { glob: "projects/**/*.jsonl", format: "claude-code" },
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: true },
  },
  {
    name: "pi",
    description: "pi coding agent (npm, JSON event stream)",
    install: {
      kind: "install",
      script: npm("@mariozechner/pi-coding-agent"),
      binary: "pi",
    },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "OPENAI_API_KEY", relay: "OPENAI_API_KEY" },
      env: { PI_CODING_AGENT_DIR: "{home}" },
      home: "/orbit/agent/pi",
      homeEnv: "PI_CODING_AGENT_DIR",
    },
    command: {
      run: ["pi", "--print", "--mode", "json", "--session-dir", "{home}/sessions", "{instruction}"],
      resume: [
        "pi",
        "--print",
        "--mode",
        "json",
        "--session-dir",
        "{home}/sessions",
        "--continue",
        "{instruction}",
      ],
      transcript: { glob: "sessions/*.jsonl", format: "jsonl" },
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "opencode",
    description: "OpenCode (npm, JSON event stream)",
    install: { kind: "install", script: npm("opencode-ai"), binary: "opencode" },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "OPENAI_API_KEY", relay: "OPENAI_API_KEY" },
      env: { OPENCODE_FAKE_VCS: "git" },
      home: "/orbit/agent/opencode",
      homeEnv: "XDG_CONFIG_HOME",
    },
    command: {
      run: [
        "opencode",
        "run",
        "--format=json",
        "--dangerously-skip-permissions",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--",
        "{instruction}",
      ],
      resume: [
        "opencode",
        "run",
        "--format=json",
        "--continue",
        "--dangerously-skip-permissions",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--",
        "{instruction}",
      ],
      transcript: { glob: "shared/opencode/*.jsonl", format: "jsonl" },
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "kimi-cli",
    description: "Kimi CLI (one prompt per invocation, stream-json)",
    install: {
      kind: "install",
      script:
        "command -v uv >/dev/null 2>&1 || { echo 'uv is required to install kimi-cli' >&2; exit 1; }; uv tool install --python 3.13 kimi-cli",
      binary: "kimi",
    },
    auth: {
      kinds: ["api-key"],
      secretEnv: { "api-key": "MOONSHOT_API_KEY" },
      home: "/orbit/agent/kimi",
      homeEnv: "KIMI_SHARE_DIR",
    },
    command: {
      run: ["kimi", "--yolo", "--auto", "-p", "{instruction}", "--output-format", "stream-json"],
      resume: [
        "kimi",
        "--yolo",
        "--auto",
        "-c",
        "-p",
        "{instruction}",
        "--output-format",
        "stream-json",
      ],
      transcript: { glob: "sessions/**/*.jsonl", format: "jsonl" },
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "gemini-cli",
    description: "Google Gemini CLI (npm)",
    install: { kind: "install", script: npm("@google/gemini-cli"), binary: "gemini" },
    auth: {
      kinds: ["api-key"],
      secretEnv: { "api-key": "GEMINI_API_KEY" },
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      home: "/orbit/agent/gemini",
      homeEnv: "GEMINI_CONFIG_DIR",
    },
    command: {
      run: [
        "gemini",
        "--yolo",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--prompt={instruction}",
      ],
      resume: [
        "gemini",
        "--yolo",
        "--resume",
        "latest",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--prompt={instruction}",
      ],
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "aider",
    description: "Aider (installer script, markdown chat history)",
    install: {
      kind: "install",
      script: "curl -LsSf https://aider.chat/install.sh | sh",
      binary: "aider",
    },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "OPENAI_API_KEY", relay: "OPENAI_API_KEY" },
      home: "/orbit/agent/aider",
    },
    command: {
      run: [
        "aider",
        "--yes",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--message={instruction}",
      ],
      resume: ["aider", "--yes", "--restore-chat-history", "--message={instruction}"],
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: false, gui: false },
  },
  {
    name: "goose",
    description: "Block Goose CLI (stream-json)",
    install: {
      kind: "install",
      script:
        "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
      binary: "goose",
    },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "OPENAI_API_KEY", relay: "OPENAI_API_KEY" },
      env: { GOOSE_DISABLE_KEYRING: "true", CONFIGURE: "false", GOOSE_MODE: "auto" },
      home: "/orbit/agent/goose",
    },
    command: {
      run: ["goose", "run", "-t", "{instruction}", "--output-format", "stream-json"],
      resume: ["goose", "run", "-t", "{instruction}", "--resume", "--output-format", "stream-json"],
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "qwen-code",
    description: "Qwen Code CLI (npm)",
    install: { kind: "install", script: npm("@qwen-code/qwen-code"), binary: "qwen" },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "OPENAI_API_KEY", relay: "OPENAI_API_KEY" },
      home: "/orbit/agent/qwen",
      homeEnv: "QWEN_CONFIG_DIR",
    },
    command: {
      run: [
        "qwen",
        "--yolo",
        "{when:model}",
        "--model",
        "{model}",
        "{end}",
        "--prompt={instruction}",
      ],
      resume: [
        "qwen",
        "--yolo",
        "--continue",
        "{when:model}",
        "--model",
        "{model}",
        "{end}",
        "--prompt={instruction}",
      ],
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "copilot-cli",
    description: "GitHub Copilot CLI (installer script, JSON output)",
    install: {
      kind: "install",
      script: "curl -fsSL https://gh.io/copilot-install | bash",
      binary: "copilot",
    },
    auth: {
      kinds: ["api-key"],
      secretEnv: { "api-key": "COPILOT_GITHUB_TOKEN" },
      home: "/orbit/agent/copilot",
      homeEnv: "COPILOT_CONFIG_DIR",
    },
    command: {
      run: [
        "copilot",
        "--yolo",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--output-format=json",
        "--prompt={instruction}",
      ],
      resume: [
        "copilot",
        "--yolo",
        "--continue",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--output-format=json",
        "--prompt={instruction}",
      ],
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
  {
    name: "mini-swe-agent",
    description: "Mini-SWE-agent (uv tool, JSON trajectory)",
    install: {
      kind: "install",
      script:
        "command -v uv >/dev/null 2>&1 || { echo 'uv is required to install mini-swe-agent' >&2; exit 1; }; uv tool install --python 3.12 mini-swe-agent",
      binary: "mini-swe-agent",
    },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "MSWEA_API_KEY", relay: "MSWEA_API_KEY" },
      env: { MSWEA_CONFIGURED: "true", MSWEA_COST_TRACKING: "ignore_errors" },
      home: "/orbit/agent/mini-swe",
    },
    command: {
      run: [
        "mini-swe-agent",
        "--yolo",
        "{when:model}",
        "--model={model}",
        "{end}",
        "--task={instruction}",
        "--output={home}/trajectory.json",
      ],
    },
    capabilities: { oneShot: true, multiTurn: false, mcp: false, gui: false },
  },
  {
    name: "dsh",
    description: "DeepSeek Harness, headless profile",
    install: {
      kind: "install",
      script: npm("@deepseek-ai/dsh"),
      binary: "dsh",
    },
    auth: {
      kinds: ["api-key", "relay"],
      secretEnv: { "api-key": "DEEPSEEK_API_KEY", relay: "DEEPSEEK_API_KEY" },
      home: "/orbit/agent/dsh",
      homeEnv: "DSH_HOME",
    },
    command: {
      run: ["dsh", "headless", "{instruction}"],
      resume: ["dsh", "headless", "--session-id", "{session}", "{instruction}"],
    },
    capabilities: { oneShot: true, multiTurn: true, mcp: true, gui: false },
  },
];

/** Placeholder substitution with `{when:key}` … `{end}` groups for optional flags. */
export function renderTemplate(
  tokens: readonly string[],
  vars: Partial<Record<"instruction" | "model" | "effort" | "session" | "home", string>>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const group = /^\{when:([a-z]+)\}$/.exec(t);
    if (group) {
      const end = tokens.indexOf("{end}", i + 1);
      const body = tokens.slice(i + 1, end === -1 ? tokens.length : end);
      if (vars[group[1] as keyof typeof vars]) out.push(...renderTemplate(body, vars));
      i = end === -1 ? tokens.length : end;
      continue;
    }
    if (t === "{end}") continue;
    out.push(
      t.replace(
        /\{(instruction|model|effort|session|home)\}/g,
        (_, k: string) => vars[k as keyof typeof vars] ?? "",
      ),
    );
  }
  return out;
}

/** Check a definition before it is stored: templates, mounts and installed binaries must agree. */
export function definitionProblem(d: AgentDefinitionInput): string | null {
  const templates: [string, string[] | undefined][] = [
    ["command.run", d.command.run],
    ["command.resume", d.command.resume],
  ];
  for (const [where, tokens] of templates) {
    if (!tokens) continue;
    const opens = tokens.filter((t) => t.startsWith("{when:")).length;
    const closes = tokens.filter((t) => t === "{end}").length;
    if (opens !== closes) return `${where}: every {when:…} needs a matching {end}`;
    for (const t of tokens)
      for (const m of t.matchAll(/\{([a-zA-Z]+)\}/g)) {
        const name = m[1] as string;
        if (name === "end" || name.startsWith("when:")) continue;
        if (!["instruction", "model", "effort", "session", "home"].includes(name))
          return `${where}: unknown placeholder {${name}}`;
      }
  }
  if (!d.command.run.some((t) => t.includes("{instruction}")))
    return "command.run must pass {instruction}";
  if (d.command.resume && !d.command.resume.some((t) => t.includes("{instruction}")))
    return "command.resume must pass {instruction}";
  if (d.install.kind === "host") {
    const dirs = d.install.pathDirs ?? [d.install.mount];
    if (!dirs.every((p) => p.startsWith("/"))) return "install.pathDirs must be absolute";
  }
  return null;
}
