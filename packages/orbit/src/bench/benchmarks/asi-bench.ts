import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route, workspace } from "./shared.ts";

export const asiBench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "asi-bench",
  name: "ASI-Bench",
  description: "Solve scientific research tasks through the benchmark's native agent runner.",
  taxonomyGroups: [
    group("Natural-science tasks", {
      ...workspace,
      domains: ["science"],
      participants: [],
      scoringEvidence: ["artifact"],
    }),
    group("Mathematical and numerical tasks", {
      ...workspace,
      domains: ["mathematics"],
      participants: [],
      scoringEvidence: ["artifact"],
    }),
    group("Robotics estimation and calibration tasks", {
      ...workspace,
      domains: ["robotics"],
      participants: [],
      scoringEvidence: ["artifact"],
    }),
    group("Computer-science and electrical-engineering tasks", {
      ...workspace,
      participants: [],
      scoringEvidence: ["artifact"],
    }),
  ],
  integrations: [
    route(
      "Built-in ASI adapter",
      "packages/orbit/src/bench/asi.ts",
      "Native Codex / Claude Code runners and reference solutions; runner constraints remain explicit.",
    ),
  ],
  verification: checked(
    "Native runner compatibility and failure handling checked. Official-runner score parity remains unverified.",
    "docs/tasks/20261009-asi-runner-timeouts.md",
  ),
  suites: ["seed31415 task catalog"],
};
