import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { type AgentDefinition, type AgentTool, AgentTools } from "../contracts/index.ts";
import { AgentError } from "./registry.ts";

/** Reserved stdio tool declarations in Orbit-generated method bundles. */
export const MCP_TOOLS_FILE = ".orbit-mcp-tools.json";

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function codexDocument(text: string) {
  try {
    return text.trim() ? parse(text) : {};
  } catch {
    throw new AgentError("invalid Agent config.toml; cannot add MCP servers");
  }
}

function servers(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AgentError("MCP servers must be a table");
  return value as Record<string, unknown>;
}

/** Preserve checkpointed MCP wiring when credentials and provider settings are refreshed. */
export function preserveCodexMcp(config: string, previous: string): string {
  const mcp = codexDocument(previous).mcp_servers;
  return mcp === undefined ? config : `${config}\n${stringify({ mcp_servers: mcp })}`;
}

export function renderMcpConfig(def: AgentDefinition, tools: AgentTool[], previous = ""): string {
  const kind = def.command.mcp.kind;
  if (kind === "none") return previous;
  let json: Record<string, unknown> = {};
  if (kind === "claude-json" && previous.trim()) {
    try {
      json = servers(JSON.parse(previous));
    } catch {
      throw new AgentError("invalid Agent orbit-mcp.json; cannot add MCP servers");
    }
  }
  const existing = servers(
    kind === "codex-toml" ? codexDocument(previous).mcp_servers : json.mcpServers,
  );
  const additions: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  > = {};
  for (const tool of AgentTools.parse(tools)) {
    if (Object.hasOwn(existing, tool.name))
      throw new AgentError(`MCP server ${tool.name} already exists in the Agent config`);
    additions[tool.name] = {
      command: tool.command[0] as string,
      args: tool.command.slice(1),
      ...(tool.env ? { env: tool.env } : {}),
    };
  }
  if (kind === "codex-toml") {
    const appended = `${previous}\n${stringify({ mcp_servers: additions })}`;
    try {
      parse(appended);
      return appended;
    } catch {
      // TOML inline tables cannot be extended; retain their values in ordinary tables instead.
      return stringify({ ...codexDocument(previous), mcp_servers: { ...existing, ...additions } });
    }
  }
  return `${JSON.stringify({ ...json, mcpServers: { ...existing, ...additions } }, null, 2)}\n`;
}

function configName(def: AgentDefinition): string {
  return def.command.mcp.kind === "codex-toml" ? "config.toml" : "orbit-mcp.json";
}

/** Reuse the method-bundle lifecycle so the trial owns all generated files. */
export function agentToolsBundle(
  def: AgentDefinition,
  bundle: string | undefined,
  tools: AgentTool[] | undefined,
  staging: string | undefined,
): string | undefined {
  if (bundle && existsSync(join(bundle, MCP_TOOLS_FILE)))
    throw new AgentError(`method bundles may not contain reserved ${MCP_TOOLS_FILE}`);
  if (!tools?.length || def.command.mcp.kind === "none") return bundle;
  if (!staging) throw new AgentError("MCP tools need a private trial staging directory");
  // Catch collisions before submitting the Run, including dotted or quoted TOML table names.
  renderMcpConfig(def, tools, bundle ? read(join(bundle, configName(def))) : "");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const generated = mkdtempSync(join(staging, "agent-mcp-"));
  try {
    if (bundle) cpSync(bundle, generated, { recursive: true, dereference: true });
    chmodSync(generated, 0o700);
    writeFileSync(join(generated, MCP_TOOLS_FILE), JSON.stringify(tools), { mode: 0o600 });
    return generated;
  } catch (e) {
    rmSync(generated, { recursive: true, force: true });
    throw e;
  }
}

/** Called after the method bundle and the current auth config reach the Agent home. */
export function installAgentTools(def: AgentDefinition, home: string): void {
  const metadata = join(home, MCP_TOOLS_FILE);
  if (!existsSync(metadata)) return;
  const tools = AgentTools.parse(JSON.parse(readFileSync(metadata, "utf8")));
  if (def.command.mcp.kind === "none") throw new AgentError(`${def.name} has no MCP wiring`);
  const file = join(home, configName(def));
  const config = renderMcpConfig(def, tools, read(file));
  writeFileSync(file, config, { mode: 0o600 });
  chmodSync(file, 0o600);
  rmSync(metadata);
}
