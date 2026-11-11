import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const robomimic: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robomimic",
  name: "RoboMimic",
  description:
    "Evaluate policies on the five classic proficient-human manipulation tasks in robosuite.",
  taxonomyGroups: [group("Demonstration-conditioned manipulation", native)],
  integrations: [
    nativeRoute(
      "PH v1.5.1 environments with separate low-dimensional and RGB policy profiles.",
      "examples/bench-adapters/embodied/ROBOMIMIC.md",
    ),
  ],
  verification: checked(
    "All five tasks passed native low-dimensional and RGB checks. Two published demonstrations replayed successfully.",
    "docs/tasks/20261110-robomimic.md",
  ),
  suites: ["Proficient Human (PH)", "Low-dimensional", "RGB"],
};
