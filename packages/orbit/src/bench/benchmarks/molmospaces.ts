import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const molmospaces: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "molmospaces",
  name: "MolmoSpaces-Bench",
  description: "Evaluate DROID manipulation across frozen indoor scenes and object configurations.",
  taxonomyGroups: [group("Indoor manipulation", native)],
  integrations: [
    nativeRoute(
      "The four MS manipulation tracks with frozen episode specifications and an independent Policy.",
      "examples/bench-adapters/embodied/benchmarks/molmospaces/README.md",
    ),
  ],
  verification: checked(
    "All 3,915 published episodes resolved against the prepared asset bundle. One sample per track matched native reset and fixed-action controls.",
    "docs/tasks/20261110-molmospaces.md",
  ),
  suites: ["Pick-v1.1", "PnP-v1", "Open-v1", "Close-v1"],
};
