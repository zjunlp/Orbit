import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const colosseumV2: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "colosseum-v2",
  name: "Colosseum V2",
  description:
    "Evaluate manipulation under visual, language and physical perturbations in ManiSkill.",
  taxonomyGroups: [group("Single-arm and bimanual robustness", native)],
  integrations: [
    nativeRoute(
      "Native tasks, applicable perturbation presets and separate single-arm and bimanual control profiles.",
      "examples/bench-adapters/embodied/COLOSSEUM.md",
    ),
  ],
  verification: checked(
    "Both control profiles passed full-horizon fixed-action native comparisons. Four tasks require additional PartNet models.",
    "docs/tasks/20261110-colosseum-v2.md",
  ),
  suites: ["Single-arm", "Bimanual"],
};
