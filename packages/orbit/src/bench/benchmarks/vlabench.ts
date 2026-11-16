import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeDocs, nativeRoute } from "./shared.ts";

export const vlabench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "vlabench",
  name: "VLABench",
  description:
    "Evaluate language-conditioned Franka manipulation with fixed scenes and open cross-task evaluation.",
  taxonomyGroups: [
    group("In-distribution, common-sense and seeded cross-task tracks", native),
    group("Cross-category and unseen-texture tracks", {
      ...native,
      targets: ["control", "generalization"],
    }),
    group("Semantic-instruction track", {
      ...native,
      targets: ["control", "instruction-following"],
    }),
  ],
  integrations: [
    nativeRoute(
      "All five published fixed tracks and the released native task registry for seeded cross-task evaluation.",
      "examples/bench-adapters/embodied/benchmarks/vlabench/README.md",
    ),
  ],
  verification: checked(
    "The released catalogs and samples across all six tracks were checked. An OpenWAM episode passed.",
    nativeDocs,
  ),
  suites: [
    "In distribution",
    "Cross category",
    "Common sense",
    "Semantic instruction",
    "Cross task",
    "Unseen texture",
  ],
};
