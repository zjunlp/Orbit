import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeRoute } from "./shared.ts";

export const chores: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "chores",
  name: "CHORES",
  description:
    "Evaluate Stretch navigation, room visitation, object pickup and fetch in ProcTHOR houses.",
  taxonomyGroups: [
    group("Navigation and manipulation", { ...native, taskTypes: ["navigation", "manipulation"] }),
  ],
  integrations: [
    nativeRoute(
      "Full CHORES-S and CHORES-L catalogs, with 1,887 and 2,091 frozen episodes.",
      "examples/bench-adapters/embodied/benchmarks/chores/README.md",
    ),
  ],
  verification: checked(
    "Both catalogs passed plan generation. Sampled SPOC and FLaRe rollouts passed native simulation, CPU verification and rescore.",
    "docs/tasks/20261114-vln-chores-hssd.md",
  ),
  suites: ["CHORES-S", "CHORES-L"],
};
