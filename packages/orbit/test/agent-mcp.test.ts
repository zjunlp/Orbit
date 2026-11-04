// Real config and bundle writers; Agent CLI execution and benchmark discovery are explicit fakes.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterClient, toRunSpec } from "../src/bench/protocol.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { BenchService } from "../src/bench/service.ts";
import { registerAgent } from "../src/cli/agent.ts";
import type { OrbitClient } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import {
  AdapterRunSpec,
  AgentDefinition,
  AuthProfile,
  BenchCapabilities,
  Benchmark,
  Run,
} from "../src/contracts/index.ts";
import {
  agentCommand,
  agentHomeDir,
  prepareAgent,
  resumeAgentCommand,
} from "../src/harness/index.ts";
import { MCP_TOOLS_FILE, renderMcpConfig } from "../src/harness/mcp.ts";
import { resumeSpec } from "../src/runs/checkpoint.ts";
import { installBundle } from "../src/runs/launch.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";
import { requireAgent } from "../test-support/agents.ts";

const dirs: string[] = [];
const stores: Store[] = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-mcp-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tools = [
  {
    name: "orbit-computer",
    command: ["orbit-computer", "mcp", 'a"b\n\\c'],
    env: { ENDPOINT: "http://computer:9000", TEXT: 'line\n"quote"' },
  },
];
const benchmark = Benchmark.parse({
  name: "gui",
  adapter: "/fixture",
  path: "/unused",
  config: {},
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
const method = (name: string, bundle?: string) => ({ name: "m", agent: name, auth: "p", bundle });
const spec = (name: string, staging?: string, bundle?: string) =>
  toRunSpec(
    { image: "fixture", agentTask: { instruction: "use either CLI or MCP", tools } },
    method(name, bundle),
    benchmark,
    "solve",
    () => requireAgent(name),
    staging,
  );

async function prepare(name: string, dir: string) {
  const def = requireAgent(name);
  await prepareAgent(
    def,
    {
      profile: AuthProfile.parse({
        name: "p",
        kind: "relay",
        harness: name,
        baseUrl: "https://relay.invalid/v1",
        model: "test-model",
        secretHint: "fixture",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
      secret: "explicit-fake-secret",
    },
    dir,
    {
      hostCli: async () => ({
        name,
        source: "/fake-cli",
        target: "/opt/fake",
        pathDirs: ["/opt/fake"],
        hostBin: "/fake-cli",
        version: "fake",
      }),
    },
  );
}

describe("MCP declarations", () => {
  it("defaults older Agent definitions to no wiring and keeps old agentTask replies valid", () => {
    const def = AgentDefinition.parse({
      name: "custom",
      install: { kind: "image", binary: "custom" },
      command: { run: ["custom", "{instruction}"] },
    });
    expect(def.command.mcp).toEqual({ kind: "none" });
    expect(
      AdapterRunSpec.parse({ agentTask: { instruction: "old" } }).agentTask?.tools,
    ).toBeUndefined();
    expect(requireAgent("codex").command.mcp.kind).toBe("codex-toml");
    expect(requireAgent("claude-code").command.mcp).toEqual({
      kind: "claude-json",
      flag: "--mcp-config",
    });
  });

  it("bounds tool declarations and continues to reject Orbit-owned fields", () => {
    const valid = { agentTask: { instruction: "do", tools } };
    expect(AdapterRunSpec.safeParse(valid).success).toBe(true);
    for (const bad of [
      [{ name: "Bad_name", command: ["x"] }],
      [{ name: "valid", command: [] }],
      [{ name: "valid", command: [""] }],
      [tools[0], tools[0]],
      Array.from({ length: 9 }, (_, i) => ({ name: `t-${i}`, command: ["x"] })),
    ])
      expect(
        AdapterRunSpec.safeParse({ agentTask: { instruction: "do", tools: bad } }).success,
      ).toBe(false);
    for (const key of ["auth", "agentBundle", "passEnv", "agent"])
      expect(AdapterRunSpec.safeParse({ ...valid, [key]: "no" }).success).toBe(false);
  });
});

describe("MCP configuration in the existing Agent bundle path", () => {
  it("writes Claude JSON to its declared home and inserts the flag before the instruction", async () => {
    const dir = temporary();
    const userBundle = join(dir, "bundle");
    mkdirSync(userBundle);
    writeFileSync(join(userBundle, "AGENTS.md"), "method instructions");
    const planned = spec("claude-code", join(dir, "staging"), userBundle);
    expect(planned.command).toEqual(
      expect.arrayContaining(["--mcp-config", "/orbit/agent/claude/orbit-mcp.json"]),
    );
    const flag = planned.command?.indexOf("--mcp-config") as number;
    expect(planned.command?.[flag + 2]).toBe("use either CLI or MCP");
    await prepare("claude-code", dir);
    installBundle(planned.agentBundle as string, dir, requireAgent("claude-code"));
    const home = join(dir, "claude");
    const config = join(home, "orbit-mcp.json");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      mcpServers: {
        "orbit-computer": {
          command: tools[0]?.command[0],
          args: tools[0]?.command.slice(1),
          env: tools[0]?.env,
        },
      },
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("method instructions");
    expect(existsSync(join(userBundle, MCP_TOOLS_FILE))).toBe(false);
    expect(existsSync(join(home, MCP_TOOLS_FILE))).toBe(false);
  });

  it("appends Codex TOML without losing auth/provider config and survives credential refresh", async () => {
    const dir = temporary();
    const planned = spec("codex", join(dir, "staging"));
    await prepare("codex", dir);
    installBundle(planned.agentBundle as string, dir, requireAgent("codex"));
    const config = join(dir, "codex", "config.toml");
    const first = parse(readFileSync(config, "utf8"));
    expect(first).toMatchObject({
      model: "test-model",
      model_provider: "orbit",
      mcp_servers: {
        "orbit-computer": {
          command: "orbit-computer",
          args: tools[0]?.command.slice(1),
          env: tools[0]?.env,
        },
      },
    });
    expect(first.model_providers).toMatchObject({ orbit: { env_key: "ORBIT_RELAY_API_KEY" } });
    await prepare("codex", dir);
    expect(parse(readFileSync(config, "utf8"))).toEqual(first);
    expect(readFileSync(config, "utf8")).not.toContain("explicit-fake-secret");
    expect(planned.command?.[0]).toBe("codex");
    expect(planned.command).not.toContain("--mcp-config");
  });

  it("preserves unrelated user servers and rejects quoted/dotted same-name tables before submission", () => {
    const dir = temporary();
    const file = join(dir, "config.toml");
    const existing = '[mcp_servers.other]\ncommand="keep"\n';
    const merged = renderMcpConfig(requireAgent("codex"), tools, existing);
    expect(merged.startsWith(existing)).toBe(true);
    expect(parse(merged).mcp_servers).toMatchObject({
      other: { command: "keep" },
      "orbit-computer": { command: "orbit-computer" },
    });
    for (const collision of [
      '[mcp_servers."orbit-computer"]\ncommand="original"\n',
      'mcp_servers.orbit-computer.command="original"\n',
    ]) {
      writeFileSync(file, collision);
      expect(() => spec("codex", join(dir, "staging"), dir)).toThrow(
        "MCP server orbit-computer already exists",
      );
      expect(readFileSync(file, "utf8")).toBe(collision);
    }
    expect(() =>
      renderMcpConfig(requireAgent("claude-code"), tools, '{"mcpServers":{"orbit-computer":{}}}'),
    ).toThrow("already exists");
    const inline = renderMcpConfig(
      requireAgent("codex"),
      tools,
      'model="kept"\nmcp_servers={other={command="keep"}}\n',
    );
    expect(parse(inline)).toMatchObject({
      model: "kept",
      mcp_servers: { other: { command: "keep" }, "orbit-computer": { command: "orbit-computer" } },
    });
  });

  it("rejects user bundles containing Orbit's reserved MCP metadata even for unwired methods", () => {
    const dir = temporary();
    writeFileSync(join(dir, MCP_TOOLS_FILE), "[]");
    expect(() => spec("codex", temporary(), dir)).toThrow("reserved");
    expect(() => spec("kimi-cli", temporary(), dir)).toThrow("reserved");
  });

  it("keeps the CLI fallback unchanged when MCP is not wired or no tools were requested", () => {
    const planned = spec("kimi-cli");
    expect(planned.agentBundle).toBeUndefined();
    expect(planned.command).toEqual(
      agentCommand(requireAgent("kimi-cli"), method("kimi-cli"), "use either CLI or MCP"),
    );
    expect(agentCommand(requireAgent("claude-code"), method("claude-code"), "do")).not.toContain(
      "--mcp-config",
    );
    expect(resumeAgentCommand(requireAgent("claude-code"), {}, { sessionId: "s" })).not.toContain(
      "--mcp-config",
    );
  });

  it("keeps the Claude MCP config flag on checkpoint resume", () => {
    const run = Run.parse({
      id: "run",
      spec: { image: "fixture", command: spec("claude-code", temporary()).command },
      state: "succeeded",
      reason: null,
      exitCode: 0,
      node: "n",
      image: "fixture",
      containerId: null,
      lease: null,
      code: null,
      cleanup: "done",
      note: "",
      createdAt: "2026-01-01",
      startedAt: null,
      endedAt: null,
      checkpoint: {
        state: "ready",
        imageId: "sha256:fixture",
        sizeBytes: 1,
        session: { harness: "claude-code", sessionId: "s" },
        createdAt: "2026-01-01",
        reason: null,
      },
    });
    const resumed = resumeSpec(run);
    const flag = resumed.command?.indexOf("--mcp-config") as number;
    expect(flag).toBeGreaterThan(0);
    expect(resumed.command?.[flag + 1]).toBe("/orbit/agent/claude/orbit-mcp.json");
    expect(resumed.command?.[flag + 2]).toContain("Continue the interrupted task");
  });

  it("rejects Agent homes outside the run's mounted Agent directory", () => {
    const def = { ...requireAgent("codex"), auth: { ...requireAgent("codex").auth, home: "/etc" } };
    expect(() => agentHomeDir(def, temporary())).toThrow("Agent home must be below");
  });
});

it("rejects a required but unwired MCP capability before creating a bench job", async () => {
  const home = temporary();
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  stores.push(store);
  const registry = new BenchmarkRegistry(paths.benchmarks);
  registry.put({ name: "gui", adapter: "/fixture", path: home });
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const submit = vi.spyOn(runs, "submit");
  vi.spyOn(AdapterClient.prototype, "tasks").mockResolvedValue({
    tasks: [],
    metrics: [],
    capabilities: BenchCapabilities.parse({
      kind: "browser",
      methods: ["cli"],
      requires: ["mcp"],
      conditions: {},
      scoreKind: "binary",
      rescore: "evidence",
    }),
  });
  const bench = new BenchService({ store, paths, runs, registry });
  await expect(bench.submit({ benchmark: "gui", methods: [method("kimi-cli")] })).rejects.toThrow(
    "has no MCP wiring",
  );
  expect(store.listJobs()).toHaveLength(0);
  expect(submit).not.toHaveBeenCalled();
});

it("agent show identifies declared MCP capability without wiring", async () => {
  const command = new Command();
  const def = requireAgent("kimi-cli");
  const output: string[] = [];
  registerAgent(
    command,
    async () =>
      ({
        agentGet: async () => ({
          definition: def,
          available: true,
          detail: "fixture",
          version: null,
        }),
      }) as unknown as OrbitClient,
    (_json, _value, format) => {
      output.push(format());
    },
  );
  await command.parseAsync(["agent", "show", "kimi-cli"], { from: "user" });
  expect(output[0]).toContain("MCP declared, not wired");
});
