import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route, workspace } from "./shared.ts";

export const terminalBenchScience: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "terminal-bench-science",
  name: "Terminal-Bench Science",
  description:
    "Perform scientific tasks in terminal workspaces with task-owned environments and verifiers.",
  taxonomyGroups: [
    group("Scientific terminal tasks", {
      ...workspace,
      domains: ["science"],
      taskTypes: ["analysis", "experimentation"],
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
    "sample-checked",
    "Reference/empty samples checked. Score parity with official Harbor execution remains unverified.",
    "docs/tasks/20261010-harbor-verifier-modes.md",
  ),
  suites: ["Science task catalog"],
};
