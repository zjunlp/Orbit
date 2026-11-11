import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, browser, checked, group, route } from "./shared.ts";

export const webvoyager: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "webvoyager",
  name: "WebVoyager",
  description:
    "Retrieve information by interacting with the WebHarbor mirror of WebVoyager websites.",
  taxonomyGroups: [
    group("Reviewed recipe-query subset", {
      ...browser,
      taskTypes: ["retrieval"],
      world: ["controlled"],
      scoringEvidence: ["response", "trajectory"],
      scoringMethods: ["model-judge"],
    }),
  ],
  integrations: [
    route(
      "CUA-Lite / WebHarbor",
      adapter("cua-lite"),
      "Five read-only recipe queries have an execution path. Requires the original mirror-site assets and terminal judge.",
    ),
  ],
  verification: checked(
    "Subset and evaluator boundaries reviewed; positive model calibration is still pending.",
    adapter("cua-lite"),
  ),
  suites: ["Five reviewed read-only tasks"],
};
