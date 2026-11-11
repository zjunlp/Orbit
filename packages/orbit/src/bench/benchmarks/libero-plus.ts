import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeDocs, nativeRoute } from "./shared.ts";

export const liberoPlus: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "libero-plus",
  name: "LIBERO-Plus",
  description:
    "Measure manipulation robustness across 10,030 variants and seven perturbation categories.",
  taxonomyGroups: [group("LIBERO robustness", native)],
  integrations: [
    nativeRoute(
      "Four native suites, with one official initial state per perturbation variant.",
      "examples/bench-adapters/embodied/LIBERO-PLUS.md",
    ),
  ],
  verification: checked(
    "sample-checked",
    "The full reset catalog was checked. Native samples span all seven perturbations, and two OFT episodes passed.",
    nativeDocs,
  ),
  suites: ["Spatial", "Object", "Goal", "Long"],
};
