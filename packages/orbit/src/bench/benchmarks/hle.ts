import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const hle: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "hle",
  name: "Humanity's Last Exam",
  description:
    "Answer original public HLE questions with offline computation, filtered web tools and independent native-prompt grading.",
  taxonomyGroups: [
    group("Public HLE with tools", {
      domains: ["science"],
      taskTypes: ["answering"],
      targets: ["reasoning", "tool-use"],
      modalities: ["text", "image"],
      interfaces: ["terminal", "tool-api"],
      platforms: ["software-system"],
      world: ["live"],
      feedback: ["step"],
      scoringEvidence: ["response"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "Restricted native CLI adapter",
      adapter("hle"),
      "Pinned public dataset and Python environment, offline Claude Code, Unix-socket model relay and filtered search/fetch service. Explicit model, judge and search backend conditions; not HLE-Diamond.",
    ),
  ],
  verification: checked(
    "Offline isolation, filtered real web tools, empty/reference controls, native CLI text/image samples and original-prompt alternate-judge rescoring checked. Full-suite, HLE-Diamond and official-harness parity are not claimed.",
    "docs/tasks/20261116-hle-with-tools.md",
  ),
  suites: ["Original public cais/hle test split (2500 questions), with tools"],
};
