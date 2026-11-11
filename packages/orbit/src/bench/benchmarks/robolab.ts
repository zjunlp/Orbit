import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const robolab: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robolab",
  name: "RoboLab",
  description: "Evaluate DROID manipulation in the official high-fidelity Isaac Lab environments.",
  taxonomyGroups: [group("Native DROID manipulation", native)],
  integrations: [
    nativeRoute(
      "Original task catalog, joint-position actions and native termination results; requires the pinned Isaac Sim runtime and assets.",
      "examples/bench-adapters/embodied/benchmarks/robolab/README.md",
    ),
  ],
  verification: checked(
    "Two native hold-control episodes, CPU verification and rescore checked; an official successful replay was checked separately. Trained-policy and full-suite parity are unverified.",
    "docs/tasks/20261109-robodojo-robolab.md",
  ),
  suites: ["Native DROID tasks"],
};
