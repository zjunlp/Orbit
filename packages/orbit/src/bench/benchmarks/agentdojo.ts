import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const agentdojo: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "agentdojo",
  name: "AgentDojo",
  description: "Native clean utility with isolated tools and independent trace replay.",
  taxonomyGroups: [
    group("Clean user tasks", {
      domains: ["business-services"],
      taskTypes: ["business-operation"],
      modalities: ["text", "structured-data"],
      interfaces: ["tool-api"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Native utility adapter",
      adapter("agentdojo"),
      "v1.2.2 clean utility only; original tools, state and utility checks.",
    ),
  ],
  verification: checked(
    "Four original suites passed native reference/empty trace replay checks. Live tool service checks remain unverified; clean utility only.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["Banking", "Slack", "Travel", "Workspace"],
};
