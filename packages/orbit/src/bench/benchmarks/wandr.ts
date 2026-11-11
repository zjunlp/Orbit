import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route, workspace } from "./shared.ts";

export const wandr: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "wandr",
  name: "WANDR",
  description:
    "Research and extract evidence from the Web, retaining native relaxed recall and all twelve reward metrics.",
  taxonomyGroups: [
    group("Web evidence collection", {
      ...workspace,
      domains: ["general-knowledge"],
      taskTypes: ["retrieval", "information-processing"],
      world: ["live"],
      scoringEvidence: ["artifact"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "Pinned Harbor suite adapter",
      adapter("harbor-suites"),
      "501 public tasks. CLI agent or empty baseline; no published oracle. Nonempty grading needs the original judge and page-fetch services.",
    ),
  ],
  verification: checked(
    "pending-calibration",
    "Original empty calibration passed with all twelve native metrics. Nonempty grading and model calibration still require the original judge and page-fetch services; full-suite parity is unverified.",
    "docs/tasks/20261110-benchmark-gaps.md",
  ),
  suites: ["Public WANDR catalog"],
};
