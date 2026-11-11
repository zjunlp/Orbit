import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const robodojo: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robodojo",
  name: "RoboDojo",
  description: "Evaluate dual-arm manipulation in the official Isaac Sim task environments.",
  taxonomyGroups: [group("Native simulated manipulation", native)],
  integrations: [
    nativeRoute(
      "Frozen native layouts, joint controls and process scores; requires the pinned Isaac Sim runtime and assets.",
      "examples/bench-adapters/embodied/ROBODOJO.md",
    ),
  ],
  verification: checked(
    "Two full-horizon native hold-control episodes, CPU verification and rescore checked. Trained-policy, positive-oracle and full-suite parity are unverified.",
    "docs/tasks/20261109-robodojo-robolab.md",
  ),
  suites: ["Native simulation tasks"],
};
