import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const cliport: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "cliport",
  name: "CLIPort",
  description:
    "Evaluate language-conditioned manipulation on the native seen and unseen test variants with RGB-D observations.",
  taxonomyGroups: [
    group("Seen language-conditioned test tasks", {
      ...native,
      modalities: ["text", "image"],
      targets: ["control"],
    }),
    group("Unseen language-conditioned test tasks", {
      ...native,
      modalities: ["text", "image"],
      targets: ["control", "generalization"],
    }),
  ],
  integrations: [
    nativeRoute(
      "Eighteen language-conditioned test entries with separate suction pick/place and spatula push profiles. The goal-image TransporterNets recipe is not included.",
      "examples/bench-adapters/embodied/benchmarks/cliport/README.md",
    ),
  ],
  verification: checked(
    "Two oracle-qualified samples per entry, native replay comparison, released-policy action checks and both action profiles passed with CPU verification and rescore. Full seed catalogs and full-suite model statistics remain pending.",
    "docs/tasks/20261112-cliport.md",
  ),
  suites: ["Language test: pick/place (16 entries)", "Language test: push (2 entries)"],
};
