import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route } from "./shared.ts";

export const textarena: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "textarena",
  name: "TextArena",
  description:
    "Play text-based single-player games using the native game rules and terminal reward.",
  taxonomyGroups: [
    group("Single-player games", {
      domains: ["games"],
      taskTypes: ["gameplay"],
      modalities: ["text"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["step"],
      participants: [],
      scoringEvidence: ["final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "Harbor TextArena conversion",
      "docs/tasks/20261105-samples-c1-c7.md",
      "38 single-player games with reference solutions; multiplayer and Elo ratings are outside this integration.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Four game families passed reference/empty checks under the converted protocol.",
    "docs/tasks/20261105-samples-c1-c7.md",
  ),
  suites: ["Single-player reference-supported games"],
};
