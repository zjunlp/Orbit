import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import type { AgentDefinitionInput, AgentInfo, AgentRef } from "../contracts/index.ts";
import type { Print } from "./auth.ts";
import { compactTable as table } from "./format.ts";

/** Parent process names, nearest first (Linux /proc). */
function ancestors(max = 12): string[] {
  const names: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < max && pid > 1; i++) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      names.push(stat.slice(open + 1, close));
      pid = Number(stat.slice(close + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return names;
}

/**
 * Identify the coding agent that invoked the CLI, so runs link to its session transcript.
 * `ORBIT_AGENT=<harness>[:<sessionId>]` overrides detection. When agents are nested (Claude Code
 * starting Codex or vice versa) the child inherits the parent's variables, so the nearest agent
 * process among the ancestors decides; environment variables are the fallback.
 */
export function detectAgent(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  parents: string[] = ancestors(),
): AgentRef | undefined {
  if (env.ORBIT_AGENT) {
    const i = env.ORBIT_AGENT.indexOf(":");
    const h = i < 0 ? env.ORBIT_AGENT : env.ORBIT_AGENT.slice(0, i);
    const sessionId = i < 0 ? "" : env.ORBIT_AGENT.slice(i + 1);
    const harness = h === "claude-code" || h === "codex" ? h : "other";
    return { harness, sessionId: sessionId || undefined, cwd };
  }
  const claude = env.CLAUDECODE === "1" || !!env.CLAUDE_CODE_SESSION_ID;
  const codexId = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  const nearest = parents.find((n) => n === "claude" || n.startsWith("codex"));
  const harness = nearest
    ? nearest === "claude"
      ? "claude-code"
      : "codex"
    : claude
      ? "claude-code"
      : codexId
        ? "codex"
        : undefined;
  if (harness === "claude-code") {
    return { harness, sessionId: env.CLAUDE_CODE_SESSION_ID || undefined, cwd };
  }
  if (harness === "codex") return { harness, sessionId: codexId || undefined, cwd };
  return undefined;
}

function formatAgents(agents: AgentInfo[]): string {
  return table([
    ["NAME", "ORIGIN", "CAPABILITIES", "ON THIS NODE", "DESCRIPTION"],
    ...agents.map((a) => [
      a.definition.name,
      a.definition.origin,
      [
        a.definition.capabilities.oneShot ? "one-shot" : "",
        a.definition.capabilities.multiTurn ? "multi-turn" : "",
        a.definition.capabilities.gui ? "gui" : "",
        a.definition.capabilities.mcp ? "mcp" : "",
      ]
        .filter(Boolean)
        .join(" "),
      a.available ? (a.version ?? "ready") : "missing",
      a.definition.description ?? "",
    ]),
  ]);
}

/**
 * `orbit agent` — the Agent definitions Orbit can drive. Built-ins ship with the package; a user
 * definition is a JSON file shaped like `contracts.AgentDefinitionInput`, so adding a CLI needs no
 * code change.
 */
export function registerAgent(program: Command, client: () => Promise<OrbitClient>, print: Print) {
  const agent = program
    .command("agent")
    .description("Agents Orbit can run (codex, claude-code, pi, opencode, … and your own)");

  agent
    .command("ls")
    .description("list definitions and whether this node can run them")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const agents = await (await client()).agentList();
      print(o.json, agents, () => formatAgents(agents));
    });

  agent
    .command("show <name>")
    .description("print one definition")
    .option("--json", "print JSON")
    .action(async (name: string, o: { json?: boolean }) => {
      const a = await (await client()).agentGet(name);
      print(o.json, a, () => JSON.stringify(a.definition, null, 2));
    });

  agent
    .command("add <file>")
    .description("register a definition from a JSON file (built-in names cannot be replaced)")
    .option("--json", "print JSON")
    .action(async (file: string, o: { json?: boolean }) => {
      const input = JSON.parse(readFileSync(file, "utf8")) as AgentDefinitionInput;
      const d = await (await client()).agentPut(input);
      print(o.json, d, () => `saved ${d.name}`);
    });

  agent
    .command("rm <name>")
    .description("delete a user definition")
    .action(async (name: string) => {
      await (await client()).agentRemove(name);
      console.log(`removed ${name}`);
    });

  agent
    .command("check <name>")
    .description("show whether this node can run the Agent, and its version")
    .option("--json", "print JSON")
    .action(async (name: string, o: { json?: boolean }) => {
      const a = await (await client()).agentGet(name);
      print(o.json, a, () =>
        [
          `${a.definition.name}: ${a.available ? "ready" : "missing"}`,
          a.detail,
          a.version ? `version ${a.version}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (!a.available) process.exitCode = 1;
    });
}
