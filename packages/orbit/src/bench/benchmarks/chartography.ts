import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const chartography: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "chartography",
  name: "Chartography",
  description:
    "Answer professional chart-reading questions through the original no-tools Inspect solver and independent judge.",
  taxonomyGroups: [
    group("Chart questions", {
      domains: ["science", "finance", "healthcare"],
      taskTypes: ["answering"],
      modalities: ["text", "image"],
      interfaces: ["response"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["none"],
      scoringEvidence: ["response"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "Native Inspect adapter",
      adapter("chartography"),
      "Original local task-pack format with charts, frozen catalog and native judge. The two dummy tasks are explicitly labelled sample; released data must be supplied separately.",
    ),
  ],
  verification: checked(
    "adapter-tested",
    "Protocol, original dummy sample loader, real vision generation and an explicitly alternate judge checked. Released-data and default-judge calibration remain pending; ten-epoch leaderboard reducers are not implemented.",
    "docs/tasks/20261110-benchmark-gaps.md",
  ),
  suites: ["User-supplied original task pack", "Two upstream dummy samples (development only)"],
};
