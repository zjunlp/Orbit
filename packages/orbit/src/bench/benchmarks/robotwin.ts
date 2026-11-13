import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeDocs, nativeRoute } from "./shared.ts";

export const robotwin: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robotwin",
  name: "RoboTwin 2.0",
  description:
    "Evaluate dual-arm manipulation with clean and randomized scenes under native control protocols.",
  taxonomyGroups: [group("Dual-arm manipulation", native)],
  integrations: [
    nativeRoute(
      "Clean and Randomized catalogs; joint-control and Cartesian policies are separate protocols.",
      "examples/bench-adapters/embodied/benchmarks/robotwin/README.md",
    ),
  ],
  verification: checked(
    "Native catalog/control checks and selected π₀.₅ / X-VLA episodes passed. Full-suite score equivalence remains unverified.",
    nativeDocs,
  ),
  suites: ["Clean", "Randomized", "Cartesian Clean", "Cartesian Randomized"],
};
