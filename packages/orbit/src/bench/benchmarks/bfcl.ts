import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const bfcl: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "bfcl",
  name: "BFCL",
  description:
    "Execute multi-turn tool calls and check their results and state changes against native references.",
  taxonomyGroups: [
    group("Multi-turn tool execution", {
      targets: ["tool-use"],
      modalities: ["text", "structured-data"],
      interfaces: ["tool-api"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["step"],
      scoringEvidence: ["trajectory"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Direct BFCL adapter",
      adapter("bfcl-multiturn"),
      "Four multi-turn files; one pinned reference inconsistency is excluded. CLI methods use Orbit's MCP scaffold.",
    ),
  ],
  verification: checked(
    "Reference, empty and sampled CLI checks passed. Orbit's scaffold is not the native leaderboard prompting protocol.",
    "docs/tasks/20261105-sample-bfcl-multiturn.md",
  ),
  suites: ["Base", "Missing function", "Missing parameter", "Long context"],
};
