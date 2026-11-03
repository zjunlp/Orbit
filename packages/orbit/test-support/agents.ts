import type { AgentDefinition } from "../src/contracts/index.ts";
import { AgentRegistry } from "../src/harness/registry.ts";

/**
 * A built-in Agent definition for tests, resolved through a registry with no user file: tests use
 * the same path the daemon does, so a change to the shipped definitions is exercised here.
 */
export function requireAgent(name: string): AgentDefinition {
  const registry = new AgentRegistry("/nonexistent/orbit-test-agents.json");
  const def = registry.get(name);
  if (!def) throw new Error(`no built-in Agent ${name}`);
  return def;
}

export const testAgents = () => new AgentRegistry("/nonexistent/orbit-test-agents.json");
