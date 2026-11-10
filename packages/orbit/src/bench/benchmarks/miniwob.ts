import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, browser, checked, group, route } from "./shared.ts";

export const miniwob: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "miniwob",
  name: "MiniWoB++",
  description: "Complete browser interaction tasks from screenshots and native task instructions.",
  taxonomyGroups: [
    group("BrowserGym / CUA-Lite tasks", {
      ...browser,
      world: ["controlled"],
      scoringEvidence: ["final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "BrowserGym adapter",
      adapter("browsergym"),
      "125 tasks with external/empty methods and GUI-capable CLI agents.",
    ),
    route(
      "CUA-Lite adapter",
      adapter("cua-lite"),
      "The same MiniWoB family through a separate screenshot-only recipe; CLI execution is restricted to calibrated tasks.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Native empty checks and selected screenshot-only agent tasks passed. Recipes and step budgets remain separate.",
    "docs/tasks/20261104-p6-cli-agent-bridge.md",
  ),
  suites: ["MiniWoB++ task catalog"],
};
