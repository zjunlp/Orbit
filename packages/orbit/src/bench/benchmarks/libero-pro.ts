import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const liberoPro: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "libero-pro",
  name: "LIBERO-PRO",
  description:
    "Evaluate manipulation across object, position, language, task and environment perturbations.",
  taxonomyGroups: [group("Task and instruction robustness", native)],
  integrations: [
    nativeRoute(
      "The initial release's twenty leaderboard conditions, with BDDL language and seeded native initial states.",
      "examples/bench-adapters/embodied/LIBERO-PRO.md",
    ),
  ],
  verification: checked(
    "All 200 condition entries passed native reset and control checks. Fixed-action language and task probes were compared against the native environment.",
    "docs/tasks/20261110-libero-pro.md",
  ),
  suites: ["Spatial", "Object", "Goal", "Long"],
};
