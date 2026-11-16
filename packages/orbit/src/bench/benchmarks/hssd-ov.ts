import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const hssdOv: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "hssd-ov",
  name: "HSSD-OV",
  description:
    "Evaluate open-vocabulary object navigation in Habitat with geodesic distance and SPL.",
  taxonomyGroups: [group("Object navigation", { ...native, taskTypes: ["navigation"] })],
  integrations: [
    nativeRoute(
      "1,751 published episodes across 43 scenes, with native STOP and frozen scoring geometry.",
      "examples/bench-adapters/embodied/benchmarks/hssd-ov/README.md",
    ),
  ],
  verification: checked(
    "The full catalog passed native loading and planning. A fixed-action rollout passed CPU verification. LightNav-0 ran in a five-step development configuration.",
    "docs/tasks/20261114-vln-chores-hssd.md",
  ),
  suites: ["Validation"],
};
