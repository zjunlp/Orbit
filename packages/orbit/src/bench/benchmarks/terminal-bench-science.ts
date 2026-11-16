import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route, workspace } from "./shared.ts";

export const terminalBenchScience: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "terminal-bench-science",
  name: "Terminal-Bench Science",
  description:
    "Perform scientific tasks in terminal workspaces with task-owned environments and verifiers.",
  taxonomyGroups: [
    group("Natural-science numerical tasks", {
      ...workspace,
      participants: [],
      scoringEvidence: ["artifact"],
      domains: ["science"],
    }),
    group("Finite Free Stam: Lean proof", {
      ...workspace,
      participants: [],
      scoringEvidence: ["artifact"],
      domains: ["mathematics"],
      taskTypes: ["implementation"],
      world: ["controlled"],
      scoringMethods: ["execution-test"],
    }),
    group("Ankle MRI findings", {
      ...workspace,
      participants: [],
      scoringEvidence: ["artifact"],
      domains: ["healthcare"],
      taskTypes: ["analysis"],
      modalities: ["text", "image"],
      world: ["controlled"],
    }),
    group("TAMP skill planning", {
      ...workspace,
      participants: [],
      scoringEvidence: ["artifact"],
      domains: ["robotics"],
      taskTypes: ["implementation"],
      targets: ["planning"],
      modalities: ["text", "structured-data"],
      platforms: ["software-system", "simulation"],
      world: ["controlled"],
    }),
    group("Other scientific terminal tasks: classification pending", {
      ...workspace,
      participants: [],
      scoringEvidence: ["artifact"],
    }),
  ],
  integrations: [
    route(
      "Harbor format",
      "docs/tasks/20261010-harbor-verifier-modes.md",
      "Task directories, compose services and separate/shared verifiers; individual task conditions still apply.",
    ),
  ],
  verification: checked(
    "Reference/empty samples checked. Score parity with official Harbor execution remains unverified.",
    "docs/tasks/20261010-harbor-verifier-modes.md",
  ),
  suites: ["Science task catalog"],
};
