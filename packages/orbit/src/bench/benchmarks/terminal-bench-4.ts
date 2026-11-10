import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route, workspace } from "./shared.ts";

export const terminalBench4: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "terminal-bench-4",
  name: "Terminal-Bench 4.0",
  description:
    "Complete terminal tasks with their own environments, dependencies and executable verification.",
  taxonomyGroups: [group("Terminal tasks", { ...workspace, scoringEvidence: ["artifact"] })],
  integrations: [
    route(
      "Harbor format",
      "docs/tasks/20261010-harbor-sidecars.md",
      "Supported task subset includes compose services; unsupported task conditions remain explicit.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Reference/empty samples checked. Coverage is partial and official-runner score parity is unverified.",
    "docs/tasks/20261010-harbor-sidecars.md",
  ),
  suites: ["4.0 task catalog (supported subset)"],
};
