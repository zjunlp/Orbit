import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeDocs, nativeRoute } from "./shared.ts";

export const robocasa365: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "robocasa365",
  name: "RoboCasa365",
  description:
    "Evaluate kitchen manipulation across atomic, composite, seen, unseen and lifelong task scopes.",
  taxonomyGroups: [
    group("Seen multitask and full-catalog manipulation", native),
    group("Unseen tasks and held-out kitchen/object splits", {
      ...native,
      targets: ["control", "generalization"],
    }),
    group("Lifelong phase and cumulative retention evaluation", {
      ...native,
      targets: ["control", "learning-adaptation"],
    }),
  ],
  integrations: [
    nativeRoute(
      "Pinned full catalog and Lifelong scopes; π₀.₅ and GR00T N1.5 recipes use different runtime and success conditions.",
      "examples/bench-adapters/embodied/benchmarks/robocasa365/README.md",
    ),
  ],
  verification: checked(
    "Native catalog checks and selected real-policy episodes passed; full catalog model evaluation is not implied.",
    nativeDocs,
  ),
  suites: ["Atomic-Seen", "Composite-Seen", "Composite-Unseen", "Full pinned catalog", "Lifelong"],
};
