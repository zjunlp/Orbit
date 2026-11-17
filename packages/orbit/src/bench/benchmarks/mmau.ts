import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, checked, group, route } from "./shared.ts";

export const mmau: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "mmau",
  name: "MMAU",
  description: "Audio understanding across sound, music and speech with original answer matching.",
  taxonomyGroups: [
    group("Audio test-mini", {
      taskTypes: ["answering"],
      modalities: ["text", "audio"],
      interfaces: ["response"],
      platforms: ["software-system"],
      world: ["controlled"],
      feedback: ["none"],
      participants: [],
      scoringEvidence: ["response"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "MMAU audio adapter",
      adapter("mmau"),
      "Public test-mini WAVs and original string matcher; audio-capable external method required.",
    ),
  ],
  verification: checked(
    "Four original audio questions across sound, music and speech passed real Docker empty/reference calibration, repeatability, rescore and cleanup checks. Native CLI comparison agreed. Oracle replay does not test model audio perception or establish full-suite parity.",
    "docs/tasks/20261116-benchmark-expansion.md",
  ),
  suites: ["Audio test-mini"],
};
