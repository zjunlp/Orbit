import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const vlaArena: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "vla-arena",
  name: "VLA-Arena",
  description:
    "Evaluate safety, distraction resistance, extrapolation and long-horizon manipulation.",
  taxonomyGroups: [
    group("Safety suites", { ...native, targets: ["control", "safety"] }),
    group("Distractor suites", { ...native, targets: ["control", "robustness"] }),
    group("Extrapolation suites", { ...native, targets: ["control", "generalization"] }),
    group("Long-horizon suites", { ...native, targets: ["control", "planning"] }),
    group("Visual and language perturbation probes", {
      ...native,
      targets: ["control", "robustness"],
    }),
  ],
  integrations: [
    nativeRoute(
      "Native suites with L0–L2 difficulty, frozen initial states and official safety scoring.",
      "examples/bench-adapters/embodied/benchmarks/vla-arena/README.md",
    ),
  ],
  verification: checked(
    "All 170 tasks and 8,500 released states were resolved. Native comparisons and a scripted safety episode passed.",
    "docs/tasks/20261110-vla-arena.md",
  ),
  suites: ["Safety", "Distractors", "Extrapolation", "Long Horizon"],
};
