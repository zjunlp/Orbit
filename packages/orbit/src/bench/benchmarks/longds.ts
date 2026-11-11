import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const longds: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "longds",
  name: "LongDS-Bench",
  description: "Complete long, multi-turn data science tasks using the original runner and judge.",
  taxonomyGroups: [
    group("Data science", {
      ...workspace,
      taskTypes: ["analysis"],
      scoringEvidence: ["response"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "Native LongDS adapter",
      adapter("longds"),
      "Lite task listing; native Codex and Claude Code runner entrypoints.",
    ),
  ],
  verification: checked(
    "A complete native Codex task was checked. Real Claude execution and continuation remain unverified.",
    "docs/tasks/20260930-r3-bench.md",
  ),
  suites: ["Lite"],
};
