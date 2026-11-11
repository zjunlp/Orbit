import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const frontiersweV2: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "frontierswe-v2",
  name: "FrontierSWE v2",
  description:
    "Solve frontier software and scientific programming tasks in their original Harbor environments.",
  taxonomyGroups: [
    group("Original coding-agent tasks", {
      ...workspace,
      domains: ["software", "science", "machine-learning"],
      taskTypes: ["implementation", "optimization"],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
  ],
  integrations: [
    route(
      "Pinned Harbor suite adapter",
      adapter("harbor-suites"),
      "Original task images, dedicated agent accounts, artifact exclusions and independent verifiers. Missing source files and unsupported task conditions remain visible.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Original reference/empty calibration and a real CLI auth check under the task account passed. Allowlist-as-public is an explicit network deviation; full-suite model parity is unverified.",
    "docs/tasks/20261110-benchmark-gaps.md",
  ),
  suites: ["v2.0.0 public tasks"],
};
