import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route, workspace } from "./shared.ts";

export const asiBench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "asi-bench",
  name: "ASI-Bench",
  description: "Solve scientific research tasks through the benchmark's native agent runner.",
  taxonomyGroups: [
    group("Scientific tasks", {
      ...workspace,
      domains: ["science"],
      taskTypes: ["analysis", "experimentation"],
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
    "sample-checked",
    "Native runner compatibility and failure handling checked. Official-runner score parity remains unverified.",
    "docs/tasks/20261009-asi-runner-timeouts.md",
  ),
  suites: ["seed31415 task catalog"],
};
