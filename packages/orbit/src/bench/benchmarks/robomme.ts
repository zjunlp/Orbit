import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const robomme: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robomme",
  name: "RoboMME",
  description: "Evaluate robot memory in native Panda manipulation tasks.",
  taxonomyGroups: [group("Robot memory", native)],
  integrations: [
    nativeRoute(
      "16 tasks and 800 frozen public test episodes using the joint-angle controller.",
      "examples/bench-adapters/embodied/benchmarks/robomme/README.md",
    ),
  ],
  verification: checked(
    "The full public test catalog is covered. See the run record for native rollout and checkpoint validation.",
    "docs/tasks/20261116-robomme-hy-vla-motus.md",
  ),
  suites: ["Counting", "Permanence", "Reference", "Imitation"],
};
