import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const posttrainbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "posttrainbench",
  name: "PostTrainBench",
  description:
    "Train or adapt a supplied model under a fixed resource budget and evaluate the resulting model.",
  taxonomyGroups: [
    group("Model post-training", {
      ...workspace,
      domains: ["machine-learning"],
      taskTypes: ["training", "optimization"],
      scoringEvidence: ["artifact"],
    }),
  ],
  integrations: [
    route(
      "PostTrainBench adapter",
      adapter("posttrainbench"),
      "Original task catalog and final_model evaluator; model-specific GPU and dataset requirements apply.",
    ),
  ],
  verification: checked(
    "Adapter fixtures checked. A full training run is not implied by adapter availability.",
    "docs/tasks/20261015-bench-adapters.md",
  ),
  suites: ["Original model post-training tasks"],
};
