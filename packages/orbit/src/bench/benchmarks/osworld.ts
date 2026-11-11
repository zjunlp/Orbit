import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, browser, checked, group, route } from "./shared.ts";

export const osworld: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "osworld",
  name: "OSWorld-V2",
  description: "Run desktop computer-use tasks with the release's original runner and evaluator.",
  taxonomyGroups: [
    group("Desktop task adapter", {
      ...browser,
      platforms: ["desktop"],
      scoringEvidence: ["final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "OSWorld-V2 adapter",
      adapter("osworld-v2"),
      "Original release catalog retained; gated files, VM images and external service conditions remain explicit.",
    ),
  ],
  verification: checked(
    "Adapter fixtures exist; real KVM-backed calibration has not run.",
    adapter("osworld-v2"),
  ),
  suites: ["V2 release task catalog"],
};
