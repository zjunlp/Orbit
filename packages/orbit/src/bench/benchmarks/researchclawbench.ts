import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const researchclawbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "researchclawbench",
  name: "ResearchClawBench",
  description:
    "Carry out scientific research and submit code, outputs and a report for rubric-based judging.",
  taxonomyGroups: [
    group("Scientific research", {
      ...workspace,
      domains: ["science"],
      taskTypes: ["experimentation"],
      scoringEvidence: ["artifact"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "ResearchClawBench adapter",
      adapter("researchclawbench"),
      "Original instructions and score_run judge; CLI methods, no reference oracle.",
    ),
  ],
  verification: checked(
    "adapter-tested",
    "Adapter and judge failure-path fixtures passed; full real-agent evaluation is pending.",
    adapter("researchclawbench"),
  ),
  suites: ["Original research task catalog"],
};
