// Real file writers against an Agent home a container could have prepared; no Agent CLI runs.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthProfile } from "../src/contracts/index.ts";
import { prepareAgent } from "../src/harness/index.ts";
import { AgentRegistry } from "../src/harness/registry.ts";
import { installBundle } from "../src/runs/launch.ts";
import { parseClaude } from "../src/sessions/index.ts";
import { requireAgent } from "../test-support/agents.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "orbit-home-safety-"));
  roots.push(d);
  return d;
};
// Explicit fake host CLI: only the configuration writers run.
const hostCli = async () => ({
  name: "codex",
  source: "/fake-cli",
  target: "/opt/fake",
  pathDirs: ["/opt/fake"],
  hostBin: "/fake-cli",
  version: "fake",
});
const entry = (harness: string) => ({
  profile: AuthProfile.parse({
    name: "p",
    kind: "api-key",
    harness,
    secretHint: "fixture",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  }),
  secret: "explicit-fake-secret",
});

it("replaces links planted in the Agent home instead of reading or writing through them", async () => {
  const root = temp();
  const agent = join(root, "agent");
  const outside = join(root, "host.toml");
  writeFileSync(outside, '[mcp_servers.host]\ncommand = "host-only"\n');
  mkdirSync(join(agent, "codex"), { recursive: true });
  symlinkSync(outside, join(agent, "codex", "config.toml"));
  symlinkSync(outside, join(agent, "codex", "auth.json"));
  await prepareAgent(requireAgent("codex"), entry("codex"), agent, { hostCli });
  expect(readFileSync(outside, "utf8")).toContain("host-only");
  expect(lstatSync(join(agent, "codex", "config.toml")).isFile()).toBe(true);
  expect(readFileSync(join(agent, "codex", "config.toml"), "utf8")).not.toContain("host-only");
  expect(lstatSync(join(agent, "codex", "auth.json")).isFile()).toBe(true);

  const linkedHome = join(root, "agent2");
  mkdirSync(linkedHome);
  symlinkSync(join(root), join(linkedHome, "codex"));
  await prepareAgent(requireAgent("codex"), entry("codex"), linkedHome, { hostCli });
  expect(lstatSync(join(linkedHome, "codex")).isDirectory()).toBe(true);
  expect(lstatSync(join(root, "config.toml"), { throwIfNoEntry: false })).toBeUndefined();
});

it("copies a method bundle without writing through links planted in the home", () => {
  const root = temp();
  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  writeFileSync(join(bundle, "AGENTS.md"), "method notes");
  const agent = join(root, "agent");
  const outside = join(root, "victim");
  writeFileSync(outside, "keep");
  mkdirSync(join(agent, "claude"), { recursive: true });
  symlinkSync(outside, join(agent, "claude", "CLAUDE.md"));
  symlinkSync(outside, join(agent, "claude", "AGENTS.md"));
  installBundle(bundle, agent, requireAgent("claude-code"));
  expect(readFileSync(outside, "utf8")).toBe("keep");
  expect(readFileSync(join(agent, "claude", "AGENTS.md"), "utf8")).toBe("method notes");
  expect(lstatSync(join(agent, "claude", "CLAUDE.md")).isSymbolicLink()).toBe(true);
});

it("refuses user Agent homes outside /orbit/agent at registration", () => {
  const reg = new AgentRegistry(join(temp(), "agents.json"));
  const def = (home: string) => ({
    name: "custom",
    install: { kind: "image" as const, binary: "x" },
    command: { run: ["x", "{instruction}"] },
    auth: { home },
  });
  for (const home of ["/root/.x", "/orbit/agent", "/orbit/agent/../etc"])
    expect(() => reg.put(def(home) as never)).toThrow(/below \/orbit\/agent/);
  expect(reg.put(def("/orbit/agent/custom") as never).name).toBe("custom");
});

it("skips an oversized transcript line and keeps reading", async () => {
  const file = join(temp(), "t.jsonl");
  const msg = (text: string) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: text },
    });
  writeFileSync(file, `${msg("first")}\n${"x".repeat(9 * 1024 * 1024)}\n${msg("last")}\n`);
  const texts = (await parseClaude(file)).map((m) => m.text);
  expect(texts).toEqual(["first", "last"]);
});
