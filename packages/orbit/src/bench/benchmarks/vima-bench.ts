import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const vimaBench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "vima-bench",
  name: "VIMA-Bench",
  description:
    "Evaluate multimodal prompt following and generalization with native PyBullet manipulation primitives.",
  taxonomyGroups: [group("Multimodal manipulation", native)],
  integrations: [
    nativeRoute(
      "Four official test partitions with multimodal prompt assets and independently served VIMA.",
      "examples/bench-adapters/embodied/benchmarks/vima-bench/README.md",
    ),
  ],
  verification: checked(
    "All four test partitions passed native checks. Selected VIMA 20M episodes passed independent verification.",
    "docs/tasks/20261110-vima-bench.md",
  ),
  suites: ["Placement", "Combinatorial", "Novel object", "Novel task"],
};
