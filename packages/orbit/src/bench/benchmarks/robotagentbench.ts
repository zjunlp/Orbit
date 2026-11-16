import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, native, route } from "./shared.ts";

export const robotagentbench: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robotagentbench",
  name: "RobotAgentBench",
  description:
    "Evaluate Agent harnesses using native robot observations and raw physical control tools.",
  taxonomyGroups: [
    group("Raw robot tool tasks", {
      ...native,
      taskTypes: ["manipulation", "navigation"],
      targets: ["planning", "tool-use", "perception-grounding", "control"],
      interfaces: ["tool-api"],
    }),
  ],
  integrations: [
    route(
      "Native raw-22 service adapter",
      adapter("robotagentbench"),
      "All 49 released groups remain visible; restored ordinary room/short-task configurations use the original worker and private closure receipts. Dedicated owners and OpenEnd/discovery scoring remain unsupported.",
    ),
  ],
  verification: checked(
    "Adapter, namespace and native receipt regression checks; real Isaac Sim task calibration remains pending.",
    "docs/tasks/20261113-behavior-robotagent.md",
  ),
  suites: ["Short", "Composite", "Cloth", "Diagnostic"],
};
