import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const calvin: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "calvin",
  name: "CALVIN",
  description: "Evaluate chains of five language instructions in the held-out scene D environment.",
  taxonomyGroups: [group("ABC→D instruction sequences", native)],
  integrations: [
    nativeRoute(
      "Frozen catalog of 1,000 native instruction sequences; benchmark registration is independent of policy weights.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Selected real π₀.₅ sequences, per-subtask scoring and independent verification checked; full-suite evaluation remains unverified.",
    "docs/tasks/20261108-embodied-calvin-xvla.md",
  ),
  suites: ["ABC→D"],
};
