import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, browser, checked, group, route } from "./shared.ts";

export const cuaBench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "cua-bench",
  name: "Cua Bench",
  description:
    "Complete basic desktop tasks using the original task variants and evaluation hooks.",
  taxonomyGroups: [
    group("Basic desktop tasks", {
      ...browser,
      platforms: ["desktop"],
      world: ["controlled"],
      scoringEvidence: ["final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Cua Bench adapter",
      adapter("cua-bench"),
      "68 basic Linux variants mapped; KiCad and workflow variants remain unsupported.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Five basic task families passed native empty/reference checks. General agents and remaining variants are not calibrated.",
    adapter("cua-bench"),
  ),
  suites: ["cua-bench-basic (Linux)"],
};
