import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const maniskill3: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "maniskill3",
  name: "ManiSkill3",
  description:
    "Evaluate manipulation tasks across a native tabletop catalog and the RLinf Plate-25 recipe.",
  taxonomyGroups: [
    group("Native manipulation tasks", { ...native, modalities: ["text", "image"] }),
  ],
  integrations: [
    nativeRoute(
      "Plate-25 and available tabletop robot/controller profiles; two asset-backed tasks remain unverified.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Native tabletop checks and selected OFT Plate-25 episodes passed. AssemblingKits and TurnFaucet still require asset validation.",
    "docs/tasks/20261109-embodied-benchmark-coverage.md",
  ),
  suites: ["Plate-25 (RLinf)", "Native tabletop profiles"],
};
