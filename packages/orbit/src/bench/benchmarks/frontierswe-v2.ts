import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const frontiersweV2: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "frontierswe-v2",
  name: "FrontierSWE v2",
  description:
    "Solve frontier software and scientific programming tasks in their original Harbor environments.",
  taxonomyGroups: [
    group("Software implementation: flash filesystem", {
      ...workspace,
      domains: ["software"],
      taskTypes: ["implementation"],
      world: ["controlled"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
    group("Software optimization: Cranelift", {
      ...workspace,
      domains: ["software"],
      taskTypes: ["optimization"],
      world: ["controlled"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
    group("Scientific model development: interatomic potential", {
      ...workspace,
      domains: ["science", "machine-learning"],
      taskTypes: ["implementation"],
      world: ["controlled"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
    group("Model post-training: multi-GPU finetuning", {
      ...workspace,
      domains: ["machine-learning"],
      taskTypes: ["training", "optimization"],
      world: ["controlled"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
    group("Other original tasks: subject classification pending", {
      ...workspace,
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
    "Original reference/empty calibration and a real CLI auth check under the task account passed. Allowlist-as-public is an explicit network deviation; full-suite model parity is unverified.",
    "docs/tasks/20261110-benchmark-gaps.md",
  ),
  suites: ["v2.0.0 public tasks"],
};
