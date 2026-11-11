import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const metaworld: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "metaworld",
  name: "Meta-World",
  description: "Evaluate Sawyer manipulation across the native MT50 task set.",
  taxonomyGroups: [group("MT50 manipulation", native)],
  integrations: [
    nativeRoute(
      "MT50 catalog through the pinned RLinf reference; keeps native task instructions and control conditions.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "All MT50 tasks passed native reset/render/control checks; selected π₀.₅ episodes passed independent verification.",
    "docs/tasks/20261108-embodied-native-expansion.md",
  ),
  suites: ["MT50"],
};
