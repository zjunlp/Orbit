import type { SupportedBenchmark } from "../../contracts/index.ts";
import { adapter, browser, checked, group, route } from "./shared.ts";

export const mobileworld: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "mobileworld",
  name: "MobileWorld",
  description: "Run original mobile task episodes through the native emulator runner.",
  taxonomyGroups: [
    group("Mobile task adapter", {
      ...browser,
      platforms: ["mobile"],
      scoringEvidence: ["final-state"],
      scoringMethods: ["rule-check"],
    }),
  ],
  integrations: [
    route(
      "MobileWorld adapter",
      adapter("mobileworld"),
      "Original catalog retained; user/MCP and live web/map dependencies are unsupported. Native emulator and KVM setup are required.",
    ),
  ],
  verification: checked(
    "Adapter fixtures exist; real native emulator calibration has not run.",
    adapter("mobileworld"),
  ),
  suites: ["Original supported mobile task classes"],
};
