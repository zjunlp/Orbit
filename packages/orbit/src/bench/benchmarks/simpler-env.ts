import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeDocs, nativeRoute } from "./shared.ts";

export const simplerEnv: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "simpler-env",
  name: "SimplerEnv",
  description:
    "Evaluate robot manipulation with Google Robot and WidowX in fixed simulation recipes and scene grids.",
  taxonomyGroups: [group("Native robot tasks", native)],
  integrations: [
    nativeRoute(
      "GR00T recipes, prepackaged tasks, visual matching and variant aggregation; policy termination is available on fixed grids.",
      "examples/bench-adapters/embodied/SIMPLER.md",
    ),
  ],
  verification: checked(
    "Native reset/render/control checks and selected GR00T episodes passed. Not every grid has real-model validation.",
    nativeDocs,
  ),
  suites: ["Google Robot", "WidowX", "Prepackaged", "Visual matching", "Variant aggregation"],
};
