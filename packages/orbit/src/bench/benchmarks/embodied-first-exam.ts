import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, route, workspace } from "./shared.ts";

export const embodiedFirstExam: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "embodied-first-exam",
  name: "Embodied First Exam",
  description:
    "Evaluate coding agents on embodied programming and interaction tasks packaged with their own simulators.",
  taxonomyGroups: [
    group("Embodied coding-agent tasks", {
      ...workspace,
      domains: ["robotics"],
      taskTypes: ["implementation"],
    }),
  ],
  integrations: [
    route(
      "Harbor format",
      "docs/tasks/20261104-p3-browsergym-efe.md",
      "Program and live task modes retain their original environment conditions. Licensed assets and some GPU tasks remain unsupported or untested.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "MetaWorld+ sample calibration and a CLI-agent sample were checked; this does not validate every included suite.",
    "docs/tasks/20261104-p6-mainline.md",
  ),
  suites: ["Embodied program tasks", "Embodied live tasks"],
};
