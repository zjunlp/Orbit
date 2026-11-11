// Product support facts, not a second registry or a record of this machine's experiments.
// One file per benchmark family under this directory; add a family by adding a file and a line here.
import { type CatalogEntry, SupportedBenchmark } from "../../contracts/index.ts";
import { asiBench } from "./asi-bench.ts";
import { automationbench } from "./automationbench.ts";
import { bfcl } from "./bfcl.ts";
import { calvin } from "./calvin.ts";
import { chartography } from "./chartography.ts";
import { cuaBench } from "./cua-bench.ts";
import { embodiedClbench } from "./embodied-clbench.ts";
import { embodiedFirstExam } from "./embodied-first-exam.ts";
import { embodiedlab } from "./embodiedlab.ts";
import { frontiersweV2 } from "./frontierswe-v2.ts";
import { humaneval } from "./humaneval.ts";
import { libero } from "./libero.ts";
import { liberoPlus } from "./libero-plus.ts";
import { longds } from "./longds.ts";
import { maniskill3 } from "./maniskill3.ts";
import { metaworld } from "./metaworld.ts";
import { miniwob } from "./miniwob.ts";
import { mobileworld } from "./mobileworld.ts";
import { onlineMind2web } from "./online-mind2web.ts";
import { osworld } from "./osworld.ts";
import { posttrainbench } from "./posttrainbench.ts";
import { researchclawbench } from "./researchclawbench.ts";
import { rlbench } from "./rlbench.ts";
import { rleBench } from "./rle-bench.ts";
import { robocasaV02 } from "./robocasa-v02.ts";
import { robocasa365 } from "./robocasa365.ts";
import { robodojo } from "./robodojo.ts";
import { robolab } from "./robolab.ts";
import { robomimic } from "./robomimic.ts";
import { robotwin } from "./robotwin.ts";
import { simplerEnv } from "./simpler-env.ts";
import { tau2Bench } from "./tau2-bench.ts";
import { terminalBench4 } from "./terminal-bench-4.ts";
import { terminalBenchScience } from "./terminal-bench-science.ts";
import { textarena } from "./textarena.ts";
import { vimaBench } from "./vima-bench.ts";
import { vlabench } from "./vlabench.ts";
import { wandr } from "./wandr.ts";
import { webvoyager } from "./webvoyager.ts";

const definitions: Omit<SupportedBenchmark, "registrationNames">[] = [
  automationbench,
  frontiersweV2,
  wandr,
  chartography,
  humaneval,
  asiBench,
  longds,
  researchclawbench,
  posttrainbench,
  bfcl,
  tau2Bench,
  terminalBenchScience,
  terminalBench4,
  textarena,
  embodiedFirstExam,
  rleBench,
  embodiedClbench,
  embodiedlab,
  miniwob,
  webvoyager,
  onlineMind2web,
  cuaBench,
  mobileworld,
  osworld,
  libero,
  liberoPlus,
  vlabench,
  simplerEnv,
  robocasaV02,
  robocasa365,
  robotwin,
  maniskill3,
  rlbench,
  metaworld,
  calvin,
  robomimic,
  vimaBench,
  robodojo,
  robolab,
];

const SUPPORTED = definitions.map((entry) =>
  SupportedBenchmark.parse({ ...entry, registrationNames: [] }),
);
const knownIds = new Set(SUPPORTED.map((entry) => entry.id));
const nativeProfiles: Record<string, string> = {
  "libero-panda-raw/1": "libero",
  "libero-plus-panda-raw/1": "libero-plus",
  "vlabench-franka-ee/1": "vlabench",
  "vima-bench-primitive/1": "vima-bench",
  "google-official-gym/1": "simpler-env",
  "widowx-official-gym/1": "simpler-env",
  "robocasa-v02-panda-arm/1": "robocasa-v02",
  "robocasa365-panda-omron-native/1": "robocasa365",
  "robotwin-aloha-agilex-native/1": "robotwin",
  "robotwin-aloha-agilex-cartesian/1": "robotwin",
  "maniskill3-native/1": "maniskill3",
  "rlbench-panda-joint-velocity/1": "rlbench",
  "rlbench-panda-rvt-pose/1": "rlbench",
  "metaworld-native/1": "metaworld",
  "calvin-native/1": "calvin",
};
for (const task of ["lift", "can", "square", "transport", "tool-hang"]) {
  for (const observation of ["low-dim", "image"]) {
    nativeProfiles[`robomimic-${task}-${observation}/1`] = "robomimic";
  }
}
for (const layout of ["panda", "panda-wrist", "panda-stick", "dual-panda", "so100"]) {
  for (const goal of ["", "-goal"])
    nativeProfiles[`maniskill3-${layout}-joint-delta${goal}/1`] = "maniskill3";
}

const collectionSuites: Record<string, string> = {
  "browsergym.miniwob": "miniwob",
  "webharbor.webvoyager": "webvoyager",
  online_mind2web: "online-mind2web",
};

function registrationFamilies(entry: CatalogEntry): string[] {
  if (entry.identitySource !== "derived") {
    if (entry.identity.id === "cua-lite")
      return (entry.listing?.coverage.suites ?? []).flatMap(({ suite, supported }) =>
        supported > 0 && Object.hasOwn(collectionSuites, suite)
          ? [collectionSuites[suite] as string]
          : [],
      );
    return knownIds.has(entry.identity.id) ? [entry.identity.id] : [];
  }
  if (entry.benchmark.adapter === "asi") return ["asi-bench"];
  const profile = entry.capabilities?.embodied?.semanticProfile?.id;
  return profile && Object.hasOwn(nativeProfiles, profile)
    ? [nativeProfiles[profile] as string]
    : [];
}

/** Link explicit identities without importing local labels, runs or scores into support facts. */
export function supportedBenchmarks(entries: CatalogEntry[]): SupportedBenchmark[] {
  const families = new Map<string, string[]>();
  for (const entry of entries) {
    for (const id of registrationFamilies(entry))
      families.set(id, [...(families.get(id) ?? []), entry.benchmark.name]);
  }
  return SUPPORTED.map((entry) => ({
    ...structuredClone(entry),
    registrationNames: [...new Set(families.get(entry.id) ?? [])].sort(),
  }));
}
