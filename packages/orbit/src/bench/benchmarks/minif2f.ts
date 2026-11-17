import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const minif2f: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "minif2f",
  name: "miniF2F",
  description: "Original Lean 3 mathematical theorem proofs checked by the native kernel.",
  taxonomyGroups: [
    group("Formal proof", {
      domains: ["mathematics"],
      taskTypes: ["implementation"],
      modalities: ["text"],
      interfaces: ["file-edit", "terminal"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["step"],
      participants: [],
      scoringEvidence: ["artifact"],
      scoringMethods: ["execution-test"],
    }),
  ],
  integrations: [
    route(
      "miniF2F Lean 3 adapter",
      adapter("minif2f"),
      "Original 488 validation/test statements, Lean 3.42.1 and pinned mathlib.",
    ),
  ],
  verification: checked(
    "Original reference and empty task controls use Lean elaboration, axiom audit and independent leanchecker; full-suite parity remains unverified.",
    "docs/tasks/20261116-remaining-benchmarks.md",
  ),
  suites: ["Lean 3 validation", "Lean 3 test"],
};
