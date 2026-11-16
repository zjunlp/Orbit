import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";
export const swebench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "swebench",
  name: "SWE-bench",
  description: "Official test-based software issue repair.",
  taxonomyGroups: [
    group("Issue repair", {
      domains: ["software"],
      taskTypes: ["repair"],
      modalities: ["text"],
      interfaces: ["terminal"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["none"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
  ],
  integrations: [
    route(
      "SWE-bench adapter",
      adapter("swebench"),
      "Official SWE-bench 3.0.15 Lite test scripts, parsers and resolved decision.",
    ),
  ],
  verification: checked(
    "Four official image tasks passed oracle=1 and empty=0 checks; unsupported image tasks remain explicit.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["SWE-bench Lite"],
};
