import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PreparationField,
  PreparationRecipe,
  type PreparationResource,
} from "../contracts/index.ts";
import { supportedBenchmarks } from "./benchmarks/index.ts";

export interface PreparationAction {
  label: string;
  argv: string[];
  unless?: string;
  capture?: string;
  output?: string;
  cwd?: string;
}
export interface RecipeDefinition {
  identity?: { id: string; name: string };
  resources: PreparationResource[];
  fields?: PreparationField[];
  actions?: PreparationAction[];
  adapter?: string;
  path?: string;
  config?: Record<string, string>;
  passEnv?: string[];
  generated?: boolean;
  datasets?: Record<string, string>;
  guide?: string;
  instructions?: string;
  hashes?: Record<string, string>;
}

const gh = "https://github.com/";
export const gitResource = (
  repo: string,
  revision: string,
  id = "source",
): PreparationResource => ({
  id,
  label: id === "source" ? "Official source and task files" : id,
  kind: "git",
  url: gh + repo,
  revision,
  access: "public",
  instructions:
    "Download the declared upstream revision, or reuse a clean checkout at that revision. Existing checkouts are never modified.",
});
const manual = (
  id: string,
  label: string,
  url: string,
  instructions: string,
  authorization = false,
): PreparationResource => ({
  id,
  label,
  kind: "manual",
  url,
  access: authorization ? "authorization" : "public",
  instructions,
  ...(authorization ? { authorizationUrl: url } : {}),
});
const field = (
  id: string,
  label: string,
  kind: PreparationField["kind"],
  help: string,
  value?: string,
): PreparationField => ({
  id,
  label,
  kind,
  help,
  required: true,
  ...(value ? { default: value } : {}),
});
const image = field(
  "image",
  "Prepared runtime image",
  "image",
  "Use the image built with this benchmark's setup guide. The original configurator validates its identity.",
);
const adapter = (name: string) => `examples/bench-adapters/${name}/adapter.py`;
const python = (path: string, ...argv: string[]): PreparationAction => ({
  label: "Prepare benchmark files",
  argv: ["python3", "-B", `{bundle}/${path}`, ...argv],
});
const native = (
  repo: string,
  revision: string,
  folder: string,
  script: string,
  args: string[] = [],
  fields: PreparationField[] = [],
  extra: PreparationResource[] = [],
): RecipeDefinition => ({
  resources: [gitResource(repo, revision), ...extra],
  fields: [image, ...fields],
  generated: true,
  actions: [
    python(
      `examples/bench-adapters/embodied/benchmarks/${folder}/${script}`,
      "--source",
      "{source}",
      "--benchmark-image",
      "{image}",
      "--output-dir",
      "{generated}",
      ...args,
    ),
  ],
  guide: `examples/bench-adapters/embodied/benchmarks/${folder}/README.md`,
});
const direct = (
  repo: string,
  revision: string,
  name: string,
  config: Record<string, string> = {},
): RecipeDefinition => ({
  resources: [gitResource(repo, revision)],
  adapter: adapter(name),
  config,
  guide: `examples/bench-adapters/${name}/README.md`,
});

const preparedImport = (name: string, url: string, prerequisites: string): RecipeDefinition => ({
  resources: [
    manual(
      "setup",
      "Original benchmark resources and native setup",
      url,
      `${prerequisites} Follow the linked adapter guide, then import a complete benchmark JSON definition with labels.identity.id set to ${name}.`,
    ),
  ],
  fields: [
    field(
      "registration",
      "Prepared benchmark JSON definition",
      "path",
      "Import the complete definition after native setup; automatic download and configuration are not implemented for this family.",
    ),
  ],
  adapter: adapter(name),
  guide: `examples/bench-adapters/${name}/README.md`,
  instructions: `${prerequisites} This entry supports importing an existing definition; native setup must be completed using the adapter guide.`,
});

// Revisions and preparation protocols come from the corresponding adapter guides and reference profiles.
const definitions: Record<string, RecipeDefinition> = {
  legalbench: preparedImport(
    "legalbench",
    "https://github.com/HazyResearch/legalbench",
    "Prepare the pinned source and official Hugging Face test TSVs under each original task directory.",
  ),
  lawbench: preparedImport(
    "lawbench",
    "https://github.com/open-compass/LawBench",
    "Prepare the pinned zero-shot task data and original evaluation sources; ChERRANT remains unsupported.",
  ),
  healthbench: preparedImport(
    "healthbench",
    "https://github.com/openai/simple-evals",
    "Prepare the pinned grader, official data with SHA-256 and explicit judge configuration; keep credentials in the daemon environment.",
  ),
  longmemeval: preparedImport(
    "longmemeval",
    "https://github.com/xiaowu0162/LongMemEval",
    "Prepare the pinned grader, original histories with SHA-256, retrieval variant and explicit judge configuration.",
  ),
  financebench: preparedImport(
    "financebench",
    "https://github.com/patronus-ai/financebench",
    "Prepare the pinned public questions, original PDFs and published human labels; new answers require answer-bound human review.",
  ),
  agentdojo: preparedImport(
    "agentdojo",
    "https://github.com/ethz-spylab/agentdojo",
    "Prepare the pinned v1.2.2 source and native service/verifier runtime for clean utility tasks.",
  ),
  swebench: preparedImport(
    "swebench",
    "https://github.com/SWE-bench/SWE-bench",
    "Prepare the pinned 3.0.15 harness, hash-bound Lite data, harness dependencies and immutable official instance image map.",
  ),
  appworld: preparedImport(
    "appworld",
    "https://github.com/StonyBrookNLP/appworld",
    "Install 0.1.3.post1 with original train/dev data, a hash-bound data manifest and an immutable native runtime image.",
  ),
  minif2f: preparedImport(
    "minif2f",
    "https://github.com/openai/miniF2F/tree/v1",
    "Prepare the pinned Lean 3 statements, Lean 3.42.1, matching mathlib/olean cache and a hash-bound tool manifest.",
  ),
  mmau: preparedImport(
    "mmau",
    "https://github.com/Sakshi113/MMAU",
    "Prepare the pinned test-mini annotations, evaluator and original WAVs; evaluation requires an audio-capable external method.",
  ),
  humaneval: {
    ...direct("openai/human-eval", "312c5e5532f0e0470bf47f77a6243e02a61da530", "humaneval"),
    path: "{source}/data",
  },
  "asi-bench": {
    resources: [gitResource("apexin-ai/ASI-Bench", "54397d39202cb6b3d43b2b8621afdc95b0b9eb5b")],
    adapter: "asi",
    fields: [
      field(
        "python",
        "ASI Python executable",
        "path",
        "Prepare the upstream Python environment and seed31415 instances as described in the adapter guide.",
      ),
    ],
    config: { python: "{python}" },
    guide: "docs/guides/bench-adapter.md",
  },
  longds: {
    ...direct("zjunlp/DataMind", "a814927159470ad1624602d233f57b7c0be5882e", "longds"),
    path: "{source}/longds",
    fields: [
      image,
      field(
        "python",
        "LongDS Python executable",
        "path",
        "Python from the upstream LongDS environment.",
      ),
    ],
    config: { image: "{image}", python: "{python}" },
    passEnv: ["JUDGE_API_KEY", "JUDGE_BASE_URL", "JUDGE_MODEL"],
  },
  researchclawbench: {
    ...direct("InternScience/ResearchClawBench", "HEAD", "researchclawbench"),
    instructions:
      "The upstream version is resolved once and cached. Prepare its task data, related work and native Python environments using the official setup instructions before registration.",
    fields: [
      field(
        "prepared",
        "Prepared benchmark directory",
        "path",
        "Original ResearchClawBench checkout with task data and native environments; use the downloaded source directory after setup.",
      ),
    ],
    path: "{prepared}",
    passEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "SCORER_MODEL"],
  },
  posttrainbench: {
    ...direct("ai4sci-bench/PostTrainBench", "HEAD", "posttrainbench"),
    fields: [
      field(
        "prepared",
        "Prepared benchmark directory",
        "path",
        "Follow the native download workflow for the selected task's data and base-model weights, then select that prepared checkout.",
      ),
    ],
    path: "{prepared}",
  },
  "terminal-bench-science": {
    resources: [
      gitResource(
        "harbor-framework/terminal-bench-science",
        "f81afac4f11048e77a15dfc8fb1dbfb897fea0ce",
      ),
    ],
    adapter: "harbor",
    path: "{source}/tasks",
    guide: "docs/guides/bench-adapter.md",
  },
  "terminal-bench-4": {
    resources: [
      gitResource("harbor-framework/terminal-bench", "452bf305c6daa62fc59061d22133a7cbc7c1572e"),
    ],
    adapter: "harbor",
    path: "{source}/tasks",
    guide: "docs/guides/bench-adapter.md",
  },
  "frontierswe-v2": {
    resources: [
      gitResource("Proximal-Labs/frontier-swe-v2", "da83f84f8fbcec3cbf0f2b17c98ebc811355c2df"),
    ],
    adapter: "examples/bench-adapters/harbor-suites/adapter.ts",
    config: { suite: "frontierswe" },
    guide: "examples/bench-adapters/harbor-suites/README.md",
  },
  wandr: {
    resources: [gitResource("perplexityai/wandr", "9ea23c7f24d0aaabc2c87b26815a513001b2e7ce")],
    adapter: "examples/bench-adapters/harbor-suites/adapter.ts",
    config: { suite: "wandr" },
    passEnv: ["OPENAI_API_KEY", "PERPLEXITY_API_KEY"],
    guide: "examples/bench-adapters/harbor-suites/README.md",
  },
  "embodied-first-exam": {
    resources: [
      gitResource("mll-lab-nu/embodied-first-exam", "9dfae8611326c4f159ebe2211cb9b71a92139406"),
    ],
    adapter: "harbor",
    path: "{source}/tasks",
    guide: "docs/tasks/20261104-p3-browsergym-efe.md",
    instructions:
      "Original task images are prepared by Orbit when run. Licensed data volumes and unsupported task conditions remain explicit in task coverage.",
  },
  textarena: {
    resources: [gitResource("harbor-framework/harbor", "b9432d2e0f62cb0eea97693501f7cf2e7f37f59f")],
    adapter: "harbor",
    path: "{directory}/tasks",
    actions: [
      {
        label: "Convert the 38 reference-supported games with the official Harbor converter",
        cwd: "{source}/adapters/textarena/src",
        output: "{directory}/tasks",
        argv: [
          "python3",
          "-B",
          "-m",
          "textarena.main",
          "--overwrite",
          "--envs-list",
          "{source}/adapters/textarena/src/textarena/oracle_tasks.json",
          "--output-dir",
          "{directory}/tasks",
        ],
      },
    ],
    guide: "docs/tasks/20261105-samples-c1-c7.md",
  },
  "tau2-bench": {
    ...direct("sierra-research/tau2-bench", "f8de30c298689cbe0117d76a378e7315a17e5bd8", "tau2"),
    fields: [image],
    config: { image: "{image}" },
  },
  bfcl: {
    resources: [],
    adapter: adapter("bfcl-multiturn"),
    path: "{directory}/data",
    fields: [image],
    config: { image: "{image}" },
    actions: [python("examples/bench-adapters/bfcl-multiturn/prepare_data.py", "{directory}/data")],
    guide: "examples/bench-adapters/bfcl-multiturn/README.md",
  },
  miniwob: {
    ...direct(
      "Farama-Foundation/miniwob-plusplus",
      "7fd85d71a4b60325c6585396ec4f48377d049838",
      "browsergym",
    ),
    fields: [image],
    config: { image: "{image}" },
  },
  "cua-bench": {
    ...direct("trycua/cua", "2829e00b180dfb08ca5ff4cbd7c95e0a14ad3409", "cua-bench"),
    path: "{source}/libs/cua-bench",
    fields: [image],
    config: { image: "{image}" },
  },
  mobileworld: {
    ...direct("Tongyi-MAI/MobileWorld", "a026188705f4a494a12d14ddab3786a23fd2c537", "mobileworld"),
    fields: [
      image,
      field(
        "python",
        "MobileWorld Python executable",
        "path",
        "Run uv sync --frozen in the official checkout; choose its Python 3.12 executable.",
      ),
    ],
    config: { image: "{image}", python: "{python}" },
  },
  osworld: {
    ...direct("xlang-ai/OSWorld-V2", "d9953673daf55381237e058fd9388cc2d74c5538", "osworld-v2"),
    resources: [
      gitResource("xlang-ai/OSWorld-V2", "d9953673daf55381237e058fd9388cc2d74c5538"),
      manual(
        "tasks",
        "Authorized release task classes",
        "https://github.com/xlang-ai/OSWorld-V2",
        "Request upstream Hugging Face access and download the osworld-v2.1 release task files using its documented downloader.",
        true,
      ),
      manual(
        "assets",
        "Authorized assets checkout",
        "https://github.com/xlang-ai/OSWorld-V2",
        "Prepare the clean pinned assets checkout at 384b3834faba5700a7b589e6cc181490c9808949 with Git LFS files materialized.",
        true,
      ),
      manual(
        "vm",
        "Original Ubuntu VM archive",
        "https://github.com/xlang-ai/OSWorld-V2",
        "Obtain osworld-v2-ubuntu-x86.qcow2.zip from the original release; preserve the archive.",
        true,
      ),
    ],
    fields: [
      field(
        "python",
        "OSWorld Python executable",
        "path",
        "Original frozen environment with Docker SDK 7.1.0; KVM must already be available.",
      ),
    ],
    config: { python: "{python}", tasksDir: "{tasks}", assetsDir: "{assets}", vmArchive: "{vm}" },
  },
  chartography: {
    ...direct("surge-ai/chartography", "3f1bf837232d3918c2cc35c6e2418c9e70d2a57b", "chartography"),
    resources: [
      gitResource("surge-ai/chartography", "3f1bf837232d3918c2cc35c6e2418c9e70d2a57b"),
      manual(
        "data",
        "Original released task pack",
        "https://github.com/surge-ai/chartography",
        "Obtain the released task pack from upstream. Public dummy examples do not stand in for the released benchmark.",
      ),
    ],
  },
  automationbench: {
    ...direct(
      "zapier/AutomationBench",
      "4a8e1061254004d9dac807054eed33fad7d1ff14",
      "automationbench",
    ),
  },
  "embodied-clbench": {
    ...direct(
      "PKU-VaLuE-Lab/EmbodiedCLBench",
      "f33105f017f5408f8d2c6debe8bd4086881d3ea4",
      "embodied-clbench",
    ),
    fields: [image],
    config: { image: "{image}" },
  },
  "rle-bench": {
    ...direct("RLE-Bench/RLE-Bench", "c6bf572283b5453c0ee76eaa3054f23d691e433d", "rle-bench"),
    fields: [image],
    config: { image: "{image}" },
  },
  embodiedlab: {
    ...direct("HexaFuture/EmbodiedLab", "5dd50ff33ec1211685f47ee38d9abf8db75656bf", "embodiedlab"),
    fields: [image],
    config: { image: "{image}" },
  },
  robotagentbench: {
    ...direct(
      "AetherLabsAI/RobotAgentBench",
      "fa207f52d8da139f591f9dc590eb002c58f72383",
      "robotagentbench",
    ),
  },
};

for (const id of ["webvoyager", "online-mind2web"])
  definitions[id] = {
    ...direct("cua-lite/cua-lite", "2af69268c0573f4c12aac391cc03125e6d5c7974", "cua-lite"),
    resources: [
      gitResource("cua-lite/cua-lite", "2af69268c0573f4c12aac391cc03125e6d5c7974"),
      gitResource(
        "Farama-Foundation/miniwob-plusplus",
        "7fd85d71a4b60325c6585396ec4f48377d049838",
        "miniwob",
      ),
    ],
  };

const rlinf = "1bf78980d9339cbc67497eddceb9a1e3a74e2acc";
const nativeDefinitions: Record<string, RecipeDefinition> = {
  "behavior-1k": native(
    "StanfordVL/BEHAVIOR-1K",
    "b544acbbb76b461349bcba21f93b870b11da6608",
    "behavior-1k",
    "configure_behavior.py",
    ["--data", "{data}"],
    [],
    [
      manual(
        "data",
        "Licensed BEHAVIOR and OmniGibson data",
        "https://github.com/StanfordVL/BEHAVIOR-1K",
        "Accept the official data license, obtain omnigibson.key and install behavior-1k-assets, omnigibson-robot-assets and 2026-challenge-task-instances. Select their prepared data directory.",
        true,
      ),
    ],
  ),
  bigym2: native(
    "swirl-uk/BiGym2",
    "35ec40923421aff26ac2a525adea428567732898",
    "bigym2",
    "configure_bigym2.py",
  ),
  "libero-mem": native(
    "libero-mem/libero-mem",
    "0eee0defa4024e51511b6e15a79f30e9620209de",
    "libero-mem",
    "configure_libero_mem.py",
    ["--base-image", "{baseImage}", "--initial-states", "{initialStates}"],
    [
      field("baseImage", "LIBERO base image", "image", "Pinned base runtime from the guide."),
      field(
        "initialStates",
        "Original initial states",
        "path",
        "Use the native initial states from the pinned upstream release.",
      ),
    ],
  ),
  "libero-plus": native(
    "sylvestf/LIBERO-plus",
    "4976dc30028e805ff8094b55501d532c48fec182",
    "libero-plus",
    "configure_libero_plus.py",
    ["--assets", "{assets}"],
    [
      field(
        "assets",
        "Prepared LIBERO-plus assets",
        "path",
        "Extract the official Sylvest/LIBERO-plus archive at dd2bd61b7d9a6fef1abc52d606e983b41886a149; select its assets directory containing scenes, textures and new_objects.",
      ),
    ],
  ),
  "libero-pro": native(
    "Zxy-MLlab/LIBERO-PRO",
    "eafdb809426b13153aa1e4c42d6601844217dfec",
    "libero-pro",
    "configure_libero_pro.py",
    ["--base-image", "{baseImage}"],
    [field("baseImage", "LIBERO base image", "image", "Pinned base runtime from the guide.")],
  ),
  "robocasa-v02": native(
    "robocasa/robocasa",
    "756598a5be52e052339bb2d957426e39015c2afb",
    "robocasa-v02",
    "configure_robocasa_v02.py",
    ["--robosuite-source", "{robosuite}", "--assets", "{assets}"],
    [
      field(
        "assets",
        "Assembled original kitchen assets",
        "path",
        "Prepare the v0.2 assets with the original download_kitchen_assets.py; the configurator validates placement sites.",
      ),
    ],
    [
      gitResource(
        "ARISE-Initiative/robosuite",
        "1a8701b90c07c6595ace4af9935d7c5ebe1baed3",
        "robosuite",
      ),
    ],
  ),
  rlbench: native(
    "stepjam/RLBench",
    "02720bba4c73fe02eb75df946b8791b806028a9d",
    "rlbench",
    "configure_rlbench.py",
    ["--pyrep-source", "{pyrep}"],
    [],
    [gitResource("stepjam/PyRep", "8f420be8064b1970aae18a9cfbc978dfb15747ef", "pyrep")],
  ),
  "vla-arena": native(
    "PKU-Alignment/VLA-Arena",
    "babe582ebffc82b979b77964a7e56417d02f63a4",
    "vla-arena",
    "configure_vla_arena.py",
  ),
  molmospaces: native(
    "allenai/molmospaces",
    "v0.2.9",
    "molmospaces",
    "configure_molmospaces.py",
    ["--assets", "{assets}"],
    [
      field(
        "assets",
        "Prepared MS-v1 assets",
        "path",
        "Use the guide's --prepare-assets operation to download the official frozen robot, scene, object and grasp archives.",
      ),
    ],
  ),
  "colosseum-v2": native(
    "jstmn/ColosseumV2",
    "d16081b3ff6ea4516821f4ad5f66daccaf51c4ed",
    "colosseum-v2",
    "configure_colosseum.py",
    ["--simulator-base", "{baseImage}", "--assets", "{assets}"],
    [
      field(
        "baseImage",
        "Simulator base image",
        "image",
        "Use the base specified by the native guide.",
      ),
      field(
        "assets",
        "Prepared scene assets",
        "path",
        "Use the native --prepare-assets operation from the guide.",
      ),
    ],
  ),
  "eb-navigation": native(
    "EmbodiedBench/EmbodiedBench",
    "9be4e980e9cd6bcb38373cd4aab7c32724bdd401",
    "eb-navigation",
    "configure_eb_navigation.py",
    ["--seenav-source", "{seenav}"],
    [],
    [gitResource("WzcTHU/SeeNav-Agent", "7ed6a59052701951bdb2c7d51dd6d9103219cf3e", "seenav")],
  ),
  cliport: native(
    "cliport/cliport",
    "2be5c47b5bb9bb7040ad90693288b87b1e18e7ad",
    "cliport",
    "configure_cliport.py",
    ["--seed-catalog", "{seeds}", "--google-assets", "{assets}"],
    [
      field(
        "seeds",
        "Frozen native seed catalog",
        "path",
        "Generate the seed catalog using configure_cliport.py --plan-seeds from the native guide.",
      ),
      field(
        "assets",
        "Original Google object assets",
        "path",
        "Extract google.zip from the official CLIPort v1.0.0 release; select its google directory.",
      ),
    ],
  ),
};
Object.assign(definitions, nativeDefinitions);

const assetsField = (help: string) => field("assets", "Prepared simulation assets", "path", help);
const renamedSource = (d: RecipeDefinition, flag: string) => {
  for (const action of d.actions ?? [])
    action.argv = action.argv.map((v) => (v === "--source" ? flag : v));
  return d;
};
definitions.libero = renamedSource(
  native(
    "moojink/openvla-oft",
    "e4287e94541f459edc4feabc4e181f537cd569a8",
    "libero",
    "configure.py",
    ["--benchmark-only", "--audit", "{audit}"],
    [
      field(
        "audit",
        "LIBERO source and image audit",
        "path",
        "Run audit.py from the native guide; select the passing audit JSON.",
      ),
    ],
  ),
  "--reference-source",
);
preparationDefinition("libero").fields = preparationDefinition("libero").fields?.filter(
  (f) => f.id !== "image",
);
preparationDefinition("libero").actions = preparationDefinition("libero").actions?.map((a) => ({
  ...a,
  argv: a.argv.filter((v) => v !== "--benchmark-image" && v !== "{image}"),
}));
definitions.vlabench = native(
  "OpenMOSS/VLABench",
  "cf588fe60c0c7282174fe979f5913170cfe69017",
  "vlabench",
  "configure_vlabench.py",
  ["--assets", "{assets}"],
  [
    assetsField(
      "Use the original VLABench scripts/download_assets.py to obtain the official archives, then select the directory containing extracted obj and scenes.",
    ),
  ],
);
definitions["simpler-env"] = renamedSource(
  native(
    "NVIDIA/Isaac-GR00T",
    "3b49067943eb1ab2eb2203b93d461c4390c78da3",
    "simpler-env",
    "configure_simpler.py",
    ["--profile", "google-prepackaged"],
  ),
  "--reference-source",
);
definitions.robocasa365 = renamedSource(
  native(
    "robocasa/robocasa",
    "8f3c96ec8d1bfcd8126cad2bca887da98d30e997",
    "robocasa365",
    "configure_robocasa365.py",
    [
      "--benchmark-only",
      "--recipe",
      "openpi",
      "--robosuite-source",
      "{robosuite}",
      "--assets",
      "{assets}",
    ],
    [assetsField("Use prepare_robocasa365_assets.py to assemble the pinned official archives.")],
    [
      gitResource(
        "ARISE-Initiative/robosuite",
        "5ce6643f3092639d08f7b0f90ed1c6a84f50552c",
        "robosuite",
      ),
    ],
  ),
  "--robocasa-source",
);
definitions.robotwin = renamedSource(
  native(
    "RoboTwin-Platform/RoboTwin",
    "ea8b21121ebb3cd201ff5b3fe361944ac94eda3f",
    "robotwin",
    "configure_robotwin.py",
    ["--assets", "{assets}"],
    [
      assetsField(
        "Prepare the original demo_clean assets with prepare_robotwin_assets.py and the official download instructions.",
      ),
    ],
  ),
  "--robotwin-source",
);
preparationDefinition("robotwin").actions?.[0]?.argv.splice(3, 0, "benchmark");
for (const model of ["maniskill3", "metaworld"])
  definitions[model] = renamedSource(
    native(
      "RLinf/RLinf",
      rlinf,
      "tabletop",
      "configure_tabletop.py",
      [
        "--model",
        model,
        "--benchmark-only",
        ...(model === "maniskill3" ? ["--assets", "{assets}"] : []),
      ],
      model === "maniskill3"
        ? [
            assetsField(
              "Obtain the native ManiSkill plate-25 assets from the official RLinf dataset.",
            ),
          ]
        : [],
    ),
    "--reference-source",
  );
definitions.calvin = renamedSource(
  native(
    "RLinf/RLinf",
    rlinf,
    "calvin",
    "configure_calvin.py",
    ["--benchmark-only", "--sequence-catalog", "{sequences}"],
    [
      field(
        "sequences",
        "Frozen native sequence catalog",
        "path",
        "Generate the 1,000 evaluation sequences with calvin_catalog.py as described in the guide.",
      ),
    ],
  ),
  "--reference-source",
);
definitions.robodojo = renamedSource(
  native(
    "RoboDojo-Benchmark/RoboDojo",
    "f57e1633ffed59761bc8e568cfe7530c4b33381c",
    "robodojo",
    "configure_robodojo.py",
    ["--assets", "{assets}", "--benchmark-only"],
    [
      assetsField(
        "Prepare the upstream Isaac Sim assets and x5 configuration using the native guide.",
      ),
    ],
  ),
  "--robodojo-source",
);
definitions.robolab = renamedSource(
  native(
    "NVlabs/RoboLab",
    "9cce00cadd5dc575fd2b8ea3836f5bdcde574229",
    "robolab",
    "configure_robolab.py",
    ["--assets", "{assets}", "--benchmark-only"],
    [
      assetsField(
        "Materialize the original RoboLab LFS assets and arrange them as specified in the native guide.",
      ),
    ],
  ),
  "--robolab-source",
);
definitions.chores = native(
  "JiahengHu/FLaRe",
  "656f46ab332b09490d30bc62b9fb58b7b4ecfd0d",
  "chores",
  "configure_chores.py",
  ["--assets", "{assets}", "--downloads", "{downloads}"],
  [
    field(
      "downloads",
      "Original SPOC archives and catalogs",
      "path",
      "Download the original CHORES-S/L catalogs, assets.tar, annotations.json.gz and val.jsonl.gz as described in the guide; keep this directory alongside the prepared assets.",
    ),
    assetsField(
      "Use the native --prepare-assets operation with the official SPOC resource archives.",
    ),
  ],
);
definitions["hssd-ov"] = native(
  "amazon-far/stopwatch",
  "bda73cbab833dcb72af23d24067bad2b56ca5ef1",
  "hssd-ov",
  "configure_hssd_ov.py",
  ["--assets", "{assets}"],
  [],
  [
    manual(
      "assets",
      "Authorized HSSD scenes and evaluation assets",
      "https://huggingface.co/datasets/hssd/hssd-hab",
      "Accept the original HSSD terms, obtain access, then use the native --prepare-assets operation to prepare the pinned assets.",
      true,
    ),
  ],
);
for (const [id, repo, revision] of [
  ["robomimic", "ARISE-Initiative/robomimic", "d309eaecc18acf4152a830a895a6984b8ac71b05"],
  ["vima-bench", "vimalabs/VIMABench", "97e0af11e126fd477c9d81eeabfb6c739021c680"],
] as const)
  definitions[id] = {
    resources: [
      gitResource(repo, revision),
      ...(id === "robomimic"
        ? [
            gitResource(
              "ARISE-Initiative/robosuite",
              "51cc01785bab80ffeed20da15e67d7dd4140e76a",
              "robosuite",
            ),
          ]
        : []),
    ],
    fields: [
      image,
      ...(id === "robomimic"
        ? [
            field(
              "data",
              "Original PH dataset files",
              "path",
              "Download the five v1.5 PH low_dim_v15.hdf5 files from the official robomimic dataset; arrange them as described in the guide.",
            ),
          ]
        : []),
    ],
    generated: true,
    actions: [
      python(
        "examples/bench-adapters/embodied/benchmarks/configure_manipulation.py",
        id,
        "--source",
        "{source}",
        "--benchmark-image",
        "{image}",
        "--output-dir",
        "{generated}",
        ...(id === "robomimic" ? ["--robosuite-source", "{robosuite}", "--data", "{data}"] : []),
      ),
    ],
    guide: `examples/bench-adapters/embodied/benchmarks/${id}/README.md`,
  };
definitions.hle = {
  resources: [
    gitResource("centerforaisafety/hle", "22ed3074b1e7b134bcbc09028d0ba320839b0655"),
    {
      id: "questions",
      label: "Original public HLE question archive",
      kind: "file",
      access: "authorization",
      url: "https://huggingface.co/datasets/cais/hle/resolve/5a81a4c7271a2a2a312b9a690f0c2fde837e4c29/data/test-00000-of-00001.parquet",
      sha256: "6d0ee0602e8aea6b159509577e884f48ecac7b8e3f6822a35f51335a446c726a",
      filename: "test.parquet",
      authorizationUrl: "https://huggingface.co/datasets/cais/hle",
      instructions:
        "Complete any Hugging Face access requirements, acknowledge access here and pass the name of a daemon environment variable containing the token, or reuse the original local Parquet file.",
    },
  ],
  guide: "examples/bench-adapters/hle/README.md",
};

const standardBuild = (folder: string, contexts: string[] = []): PreparationAction[] => [
  {
    label: "Build the pinned benchmark runtime",
    unless: "image",
    argv: [
      "docker",
      "build",
      "--label",
      "orbit.task=benchmark-preparation",
      ...contexts,
      "-f",
      `{bundle}/examples/bench-adapters/${folder}/Dockerfile`,
      "-t",
      "{imageTag}",
      `{bundle}/examples/bench-adapters/${folder}`,
    ],
  },
  {
    label: "Freeze the runtime image identity",
    unless: "image",
    argv: ["docker", "image", "inspect", "--format", "{{.Id}}", "{imageTag}"],
    capture: "image",
  },
];
for (const [id, folder] of [
  ["bfcl", "bfcl-multiturn"],
  ["tau2-bench", "tau2"],
  ["miniwob", "browsergym"],
  ["cua-bench", "cua-bench"],
  ["embodied-clbench", "embodied-clbench"],
] as const) {
  const d = definitions[id] as RecipeDefinition;
  d.actions = [...standardBuild(folder), ...(d.actions ?? [])];
  d.fields = d.fields?.map((f) =>
    f.id === "image"
      ? {
          ...f,
          required: false,
          help: "Optional: reuse an existing runtime. Otherwise Orbit builds the adapter's pinned Dockerfile and records its immutable image ID.",
        }
      : f,
  );
}
preparationDefinition("bfcl").actions?.forEach((a) => {
  if (a.argv.some((v) => v.endsWith("prepare_data.py")))
    a.output = "{directory}/data/BFCL_v4_multi_turn_base.json";
});
preparationDefinition("embodied-clbench").fields?.push(
  field(
    "data",
    "Official input data",
    "path",
    "Download and verify the official input pack as described upstream. The directory must contain input/merged and subsets.",
  ),
);
preparationDefinition("embodied-clbench").config = {
  image: "{image}",
  data: "{data}",
  subset: "stage0_smoke",
};
preparationDefinition("embodiedlab").fields?.push(
  field(
    "labImage",
    "Prepared Isaac Sim laboratory image",
    "image",
    "Build Dockerfile.lab after completing upstream runtime installation and its required terms.",
  ),
);
preparationDefinition("embodiedlab").config = {
  image: "{image}",
  labImage: "{labImage}",
  exposure: "T0",
};
preparationDefinition("rle-bench").fields = [
  field(
    "prepared",
    "Prepared RLE source directory",
    "path",
    "Run the bundled rle-bench/prepare.py --catalog and the selected task's --build operation as described in the guide. Existing source files are not modified by this entry.",
  ),
];
preparationDefinition("rle-bench").path = "{prepared}";
preparationDefinition("rle-bench").config = {};

for (const id of ["automationbench", "chartography"] as const) {
  const d = preparationDefinition(id);
  d.generated = false;
  d.fields = [
    {
      ...image,
      required: false,
      help: "Optional: reuse a prepared image; otherwise build from the pinned original source.",
    },
  ];
  d.path = "{directory}/data";
  d.actions = [
    ...standardBuild(id, ["--build-context", "upstream={source}"]),
    {
      label: "Export the original task catalog",
      argv: [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "{uid}:{gid}",
        "-e",
        "ORBIT_OUTPUT=/out",
        "-v",
        "{directory}/data:/out",
        ...(id === "chartography" ? ["-v", "{data}:/pack:ro"] : []),
        "{image}",
        "python",
        "/opt/orbit-adapter/runtime.py",
        "catalog",
      ],
    },
  ];
  d.hashes = { catalogSha256: "{directory}/data/catalog.json" };
  d.config = {
    image: "{image}",
    catalogSha256: "{catalogSha256}",
    ...(id === "chartography" ? { taskPack: "{data}", variant: "task-pack" } : { split: "public" }),
  };
  if (id === "chartography") {
    d.passEnv = ["JUDGE_API_KEY"];
    const data = d.resources.find((r) => r.id === "data");
    if (data) {
      data.access = "authorization";
      data.authorizationUrl = data.url;
      data.instructions =
        "Obtain the authorized released task pack from its owner. Select the original directory containing manifest.yaml and chart images; public dummy examples are not the released suite.";
    }
  }
}

// These original configurators provide both native image building and frozen registration.
for (const id of ["bigym2", "vima-bench"] as const) {
  const d = preparationDefinition(id);
  const configure = d.actions?.[0];
  if (!configure) throw new Error(`Missing ${id} configurator`);
  const prefix = configure.argv.slice(0, id === "vima-bench" ? 4 : 3);
  d.actions = [
    {
      label: "Build the original native runtime",
      unless: "image",
      argv: [...prefix, "--source", "{source}", "--build-tag", "{imageTag}"],
    },
    {
      label: "Freeze the native runtime image",
      unless: "image",
      argv: ["docker", "image", "inspect", "--format", "{{.Id}}", "{imageTag}"],
      capture: "image",
    },
    configure,
  ];
  d.fields = d.fields?.map((f) =>
    f.id === "image"
      ? {
          ...f,
          required: false,
          help: "Optional: reuse a validated simulator image. Otherwise run the original native build recipe.",
        }
      : f,
  );
}

preparationDefinition("bfcl").resources = [
  {
    id: "wheel",
    label: "Official BFCL release and task data",
    kind: "file",
    access: "public",
    url: "https://files.pythonhosted.org/packages/ba/41/ed458527c770c50225b60bae3b0c3444b26804ee455fa2d8f187018d2cb2/bfcl_eval-2026.3.23-py3-none-any.whl",
    sha256: "3bb6dfa5f0c68ad403c9ec50b00db2bb3b4cc9b38ab1ff33f48fe30d853d3a0a",
    filename: "bfcl.whl",
    instructions:
      "Download the pinned upstream release from PyPI. Orbit extracts and validates the original question, answer and tool files.",
  },
];
preparationDefinition("bfcl").actions?.forEach((a) => {
  if (a.argv.some((v) => v.endsWith("prepare_data.py"))) a.argv.push("--wheel", "{wheel}");
});

preparationDefinition("hle").adapter = adapter("hle");
preparationDefinition("hle").path = "{directory}/questions";
preparationDefinition("hle").generated = false;
preparationDefinition("hle").fields = [
  image,
  field(
    "gatewayImage",
    "Prepared web gateway image",
    "image",
    "Build gateway.Dockerfile from the guide and use its immutable image ID.",
  ),
  field(
    "python",
    "Python executable with pyarrow",
    "path",
    "Use a Python environment containing pyarrow to prepare the original Parquet.",
  ),
  field(
    "judgeKeyFile",
    "Private judge-key file",
    "path",
    "Path to your mode-0600 judge credential file; only its path is recorded.",
  ),
  field(
    "judgeBaseUrl",
    "Judge API endpoint",
    "text",
    "Original OpenAI-compatible judge endpoint; no credentials in the URL.",
  ),
  field(
    "judgeModel",
    "Judge model",
    "text",
    "Select the original judge or record an explicit alternate judge.",
  ),
  field(
    "modelBaseUrl",
    "Model API endpoint",
    "text",
    "Anthropic-compatible endpoint prefix, before /v1/messages; no credentials in the URL.",
  ),
];
preparationDefinition("hle").actions = [
  {
    ...python("examples/bench-adapters/hle/prepare.py", "{questions}", "{directory}/questions"),
    argv: [
      "{python}",
      "-B",
      "{bundle}/examples/bench-adapters/hle/prepare.py",
      "{questions}",
      "{directory}/questions",
    ],
    output: "{directory}/questions/catalog.json",
  },
];
preparationDefinition("hle").hashes = { catalogSha256: "{directory}/questions/catalog.json" };
preparationDefinition("hle").config = Object.fromEntries(
  [
    "image",
    "gatewayImage",
    "source",
    "catalogSha256",
    "judgeKeyFile",
    "judgeBaseUrl",
    "judgeModel",
    "modelBaseUrl",
  ].map((key) => [key, `{${key}}`]),
);

for (const id of ["webvoyager", "online-mind2web"] as const) {
  const d = preparationDefinition(id);
  d.identity = { id: "cua-lite", name: "CUA-Lite collection" };
  d.instructions =
    "Prepare the original CUA-Lite integration for this web suite. The registered collection also lists other suites with their own coverage. Select this suite's supported tasks explicitly when evaluating; judge credentials are required at evaluation time.";
  d.passEnv = ["OPENAI_API_KEY"];
  d.generated = false;
  d.fields = [
    image,
    field(
      "backend",
      "Prepared original web backend image",
      "image",
      "Use prepare_backend.py and the original native backend; enter its immutable image ID.",
    ),
  ];
  d.actions = standardBuild("cua-lite");
  d.config = {
    image: "{image}",
    miniwob: "{miniwob}",
    [id === "webvoyager" ? "webVoyagerImage" : "onlineMind2WebImage"]: "{backend}",
  };
}

preparationDefinition("robotagentbench").generated = true;
preparationDefinition("robotagentbench").resources = [
  gitResource("AetherLabsAI/RobotAgentBench", "fa207f52d8da139f591f9dc590eb002c58f72383"),
  manual(
    "selection",
    "Authorized native deployment selection",
    "https://github.com/AetherLabsAI/RobotAgentBench",
    "Complete upstream installation and runtime terms, restore the saved configurations and prepare the CPU-only namespace. Select the resulting selection.json.",
    true,
  ),
];
preparationDefinition("robotagentbench").fields = [
  field(
    "nativeImage",
    "Prepared native image",
    "image",
    "Final immutable native simulator image used for the original deployment.",
  ),
  field(
    "agentImage",
    "Agent / verifier image",
    "image",
    "Build the adapter's Dockerfile as described in its guide.",
  ),
  field(
    "deployment",
    "Prepared deployment name",
    "text",
    "Name produced by the upstream namespace preparation.",
  ),
  field(
    "lockRoot",
    "Native lock directory",
    "path",
    "Use the original deployment's lock directory.",
  ),
];
preparationDefinition("robotagentbench").actions = [
  python(
    "examples/bench-adapters/robotagentbench/prepare.py",
    "--source",
    "{source}",
    "--selection",
    "{selection}",
    "--native-image",
    "{nativeImage}",
    "--agent-image",
    "{agentImage}",
    "--deployment",
    "{deployment}",
    "--lock-root",
    "{lockRoot}",
    "--output-dir",
    "{generated}",
  ),
];

export function preparationDefinition(id: string): RecipeDefinition {
  const definition = definitions[id];
  if (!definition) throw new Error(`No preparation recipe for ${id}`);
  return definition;
}

export function preparationRecipes() {
  return supportedBenchmarks([]).map((benchmark) => {
    const d = preparationDefinition(benchmark.id);
    return PreparationRecipe.parse({
      id: benchmark.id,
      name: benchmark.name,
      description: d.instructions ?? benchmark.description,
      guide: d.guide ? `${gh}zjunlp/Orbit/blob/main/${d.guide}` : benchmark.integrations[0]?.url,
      resources: d.resources,
      fields: d.fields ?? [],
      steps: [
        ...d.resources.map((r) => `Download or reuse ${r.label}`),
        ...(d.actions ?? []).map((a) => a.label),
        "Validate task listing and register with Orbit",
      ],
    });
  });
}

/** The installed package carries the same relative adapter / SDK layout as the source tree. */
export function preparationBundle(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++, dir = dirname(dir)) {
    for (const root of [join(dir, "bench-assets"), dir])
      if (existsSync(join(root, "examples/bench-adapters/humaneval/adapter.py"))) return root;
  }
  throw new Error(
    "Benchmark preparation assets are missing; reinstall the complete Orbit package.",
  );
}
