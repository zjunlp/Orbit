import type { SupportedBenchmark } from "../../contracts/index.ts";
import { checked, group, native, nativeDocs, nativeRoute, route } from "./shared.ts";

export const libero: Omit<SupportedBenchmark, "registrationNames"> = {
  id: "libero",
  name: "LIBERO",
  description:
    "Evaluate language-conditioned robot manipulation across spatial, object, goal and long-horizon suites.",
  taxonomyGroups: [group("Native manipulation tasks", native)],
  integrations: [
    nativeRoute(
      "All five suites; OpenPI, OFT and other policy recipes retain their own control conditions.",
    ),
    route(
      "vla-eval adapter",
      "examples/bench-adapters/vla-eval/adapter.py",
      "LIBERO Spatial external/empty path; a separate execution recipe within the same benchmark family.",
    ),
  ],
  verification: checked(
    "sample-checked",
    "Native task catalogs and selected real-policy episodes checked; full-suite statistical equivalence remains unverified.",
    nativeDocs,
  ),
  suites: ["Spatial", "Object", "Goal", "Long", "LIBERO-90"],
};
