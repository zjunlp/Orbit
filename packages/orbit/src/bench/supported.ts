// Product support facts, not a second registry or a record of this machine's experiments.
import { type BenchTaxonomy, type CatalogEntry, SupportedBenchmark } from "../contracts/index.ts";

const source = (path: string) => `https://github.com/zjunlp/Orbit/blob/main/${path}`;
const adapter = (name: string) => `examples/bench-adapters/${name}/README.md`;
const route = (name: string, path: string, scope: string) => ({ name, url: source(path), scope });
const checked = (
  level: SupportedBenchmark["verification"]["level"],
  detail: string,
  path: string,
) => ({ level, detail, url: source(path) });
const group = (label: string, taxonomy: BenchTaxonomy) => ({ label, taxonomy });

const workspace: BenchTaxonomy = {
  modalities: ["text"],
  interfaces: ["terminal", "file-edit"],
  platforms: ["software-system"],
  feedback: ["step"],
};
const browser: BenchTaxonomy = {
  modalities: ["text", "image"],
  interfaces: ["gui"],
  platforms: ["browser"],
  feedback: ["step"],
  participants: [],
};
const native: BenchTaxonomy = {
  domains: ["robotics"],
  taskTypes: ["manipulation"],
  modalities: ["text", "image", "structured-data"],
  interfaces: ["physical-control"],
  platforms: ["simulation"],
  world: ["controlled"],
  feedback: ["step"],
  participants: [],
  scoringEvidence: ["trajectory"],
  scoringMethods: ["rule-check"],
};
const nativeDocs = "docs/guides/embodied-compatibility.md";
const nativeRoute = (scope: string, path = adapter("embodied")) =>
  route("Native policy adapter", path, scope);

const definitions: Omit<SupportedBenchmark, "registrationNames">[] = [
  {
    id: "automationbench",
    name: "AutomationBench",
    description:
      "Execute business workflows through the original simulated service APIs and strict task rubric.",
    taxonomyGroups: [
      group("Public and simple workflows", {
        domains: ["business-services"],
        taskTypes: ["business-operation"],
        targets: ["tool-use"],
        modalities: ["text", "structured-data"],
        interfaces: ["tool-api"],
        platforms: ["software-system"],
        world: ["controlled"],
        feedback: ["step"],
        scoringEvidence: ["final-state", "trajectory"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Native auto-bench adapter",
        adapter("automationbench"),
        "600 public tasks and 200 simple tasks registered separately. Native external agent and empty baseline; the leaderboard's private split is unavailable.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Original empty scoring and a real model rollout checked. Full-suite model evaluation and private leaderboard parity are unverified.",
      "docs/tasks/20261110-benchmark-gaps.md",
    ),
    suites: ["Public (six business domains)", "Simple (separate calibration suite)"],
  },
  {
    id: "frontierswe-v2",
    name: "FrontierSWE v2",
    description:
      "Solve frontier software and scientific programming tasks in their original Harbor environments.",
    taxonomyGroups: [
      group("Original coding-agent tasks", {
        ...workspace,
        domains: ["software", "science", "machine-learning"],
        taskTypes: ["implementation", "optimization"],
        scoringEvidence: ["artifact"],
        scoringMethods: ["execution-test"],
      }),
    ],
    integrations: [
      route(
        "Pinned Harbor suite adapter",
        adapter("harbor-suites"),
        "Original task images, dedicated agent accounts, artifact exclusions and independent verifiers. Missing source files and unsupported task conditions remain visible.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Original reference/empty calibration and a real CLI auth check under the task account passed. Allowlist-as-public is an explicit network deviation; full-suite model parity is unverified.",
      "docs/tasks/20261110-benchmark-gaps.md",
    ),
    suites: ["v2.0.0 public tasks"],
  },
  {
    id: "wandr",
    name: "WANDR",
    description:
      "Research and extract evidence from the Web, retaining native relaxed recall and all twelve reward metrics.",
    taxonomyGroups: [
      group("Web evidence collection", {
        ...workspace,
        domains: ["general-knowledge"],
        taskTypes: ["retrieval", "information-processing"],
        world: ["live"],
        scoringEvidence: ["artifact"],
        scoringMethods: ["model-judge"],
      }),
    ],
    integrations: [
      route(
        "Pinned Harbor suite adapter",
        adapter("harbor-suites"),
        "501 public tasks. CLI agent or empty baseline; no published oracle. Nonempty grading needs the original judge and page-fetch services.",
      ),
    ],
    verification: checked(
      "pending-calibration",
      "Original empty calibration passed with all twelve native metrics. Nonempty grading and model calibration still require the original judge and page-fetch services; full-suite parity is unverified.",
      "docs/tasks/20261110-benchmark-gaps.md",
    ),
    suites: ["Public WANDR catalog"],
  },
  {
    id: "chartography",
    name: "Chartography",
    description:
      "Answer professional chart-reading questions through the original no-tools Inspect solver and independent judge.",
    taxonomyGroups: [
      group("Chart questions", {
        domains: ["science", "finance", "healthcare"],
        taskTypes: ["answering"],
        modalities: ["text", "image"],
        interfaces: ["response"],
        platforms: ["software-system"],
        world: ["controlled"],
        feedback: ["none"],
        scoringEvidence: ["response"],
        scoringMethods: ["model-judge"],
      }),
    ],
    integrations: [
      route(
        "Native Inspect adapter",
        adapter("chartography"),
        "Original local task-pack format with charts, frozen catalog and native judge. The two dummy tasks are explicitly labelled sample; released data must be supplied separately.",
      ),
    ],
    verification: checked(
      "adapter-tested",
      "Protocol, original dummy sample loader, real vision generation and an explicitly alternate judge checked. Released-data and default-judge calibration remain pending; ten-epoch leaderboard reducers are not implemented.",
      "docs/tasks/20261110-benchmark-gaps.md",
    ),
    suites: ["User-supplied original task pack", "Two upstream dummy samples (development only)"],
  },
  {
    id: "humaneval",
    name: "HumanEval",
    description:
      "Generate Python functions from specifications and check them with execution tests.",
    taxonomyGroups: [
      group("Function generation", {
        domains: ["software"],
        taskTypes: ["implementation"],
        modalities: ["text"],
        interfaces: ["response"],
        platforms: ["software-system"],
        world: ["controlled"],
        feedback: ["none"],
        participants: [],
        scoringEvidence: ["artifact"],
        scoringMethods: ["execution-test"],
      }),
    ],
    integrations: [
      route(
        "HumanEval adapter",
        "examples/bench-adapters/humaneval/adapter.py",
        "Original 164-task Python catalog; oracle, empty and external methods.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Reference and empty checks passed; this is integration validation, not a model leaderboard result.",
      "docs/tasks/20261105-samples-c1-c7.md",
    ),
    suites: ["Python function completion"],
  },
  {
    id: "asi-bench",
    name: "ASI-Bench",
    description: "Solve scientific research tasks through the benchmark's native agent runner.",
    taxonomyGroups: [
      group("Scientific tasks", {
        ...workspace,
        domains: ["science"],
        taskTypes: ["analysis", "experimentation"],
      }),
    ],
    integrations: [
      route(
        "Built-in ASI adapter",
        "packages/orbit/src/bench/asi.ts",
        "Native Codex / Claude Code runners and reference solutions; runner constraints remain explicit.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native runner compatibility and failure handling checked. Official-runner score parity remains unverified.",
      "docs/tasks/20261009-asi-runner-timeouts.md",
    ),
    suites: ["seed31415 task catalog"],
  },
  {
    id: "longds",
    name: "LongDS-Bench",
    description:
      "Complete long, multi-turn data science tasks using the original runner and judge.",
    taxonomyGroups: [
      group("Data science", {
        ...workspace,
        taskTypes: ["analysis"],
        scoringEvidence: ["response"],
        scoringMethods: ["model-judge"],
      }),
    ],
    integrations: [
      route(
        "Native LongDS adapter",
        adapter("longds"),
        "Lite task listing; native Codex and Claude Code runner entrypoints.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "A complete native Codex task was checked. Real Claude execution and continuation remain unverified.",
      "docs/tasks/20260930-r3-bench.md",
    ),
    suites: ["Lite"],
  },
  {
    id: "researchclawbench",
    name: "ResearchClawBench",
    description:
      "Carry out scientific research and submit code, outputs and a report for rubric-based judging.",
    taxonomyGroups: [
      group("Scientific research", {
        ...workspace,
        domains: ["science"],
        taskTypes: ["experimentation"],
        scoringEvidence: ["artifact"],
        scoringMethods: ["model-judge"],
      }),
    ],
    integrations: [
      route(
        "ResearchClawBench adapter",
        adapter("researchclawbench"),
        "Original instructions and score_run judge; CLI methods, no reference oracle.",
      ),
    ],
    verification: checked(
      "adapter-tested",
      "Adapter and judge failure-path fixtures passed; full real-agent evaluation is pending.",
      adapter("researchclawbench"),
    ),
    suites: ["Original research task catalog"],
  },
  {
    id: "posttrainbench",
    name: "PostTrainBench",
    description:
      "Train or adapt a supplied model under a fixed resource budget and evaluate the resulting model.",
    taxonomyGroups: [
      group("Model post-training", {
        ...workspace,
        domains: ["machine-learning"],
        taskTypes: ["training", "optimization"],
        scoringEvidence: ["artifact"],
      }),
    ],
    integrations: [
      route(
        "PostTrainBench adapter",
        adapter("posttrainbench"),
        "Original task catalog and final_model evaluator; model-specific GPU and dataset requirements apply.",
      ),
    ],
    verification: checked(
      "adapter-tested",
      "Adapter fixtures checked. A full training run is not implied by adapter availability.",
      "docs/tasks/20261015-bench-adapters.md",
    ),
    suites: ["Original model post-training tasks"],
  },
  {
    id: "bfcl",
    name: "BFCL",
    description:
      "Execute multi-turn tool calls and check their results and state changes against native references.",
    taxonomyGroups: [
      group("Multi-turn tool execution", {
        targets: ["tool-use"],
        modalities: ["text", "structured-data"],
        interfaces: ["tool-api"],
        platforms: ["software-system"],
        world: ["controlled"],
        feedback: ["step"],
        scoringEvidence: ["trajectory"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Direct BFCL adapter",
        adapter("bfcl-multiturn"),
        "Four multi-turn files; one pinned reference inconsistency is excluded. CLI methods use Orbit's MCP scaffold.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Reference, empty and sampled CLI checks passed. Orbit's scaffold is not the native leaderboard prompting protocol.",
      "docs/tasks/20261105-sample-bfcl-multiturn.md",
    ),
    suites: ["Base", "Missing function", "Missing parameter", "Long context"],
  },
  {
    id: "tau2-bench",
    name: "τ²-bench",
    description:
      "Check airline and retail service workflows using the original task definitions and offline evaluator.",
    taxonomyGroups: [
      group("Offline airline and retail calibration", {
        domains: ["business-services"],
        taskTypes: ["business-operation"],
        modalities: ["text", "structured-data"],
        interfaces: ["tool-api", "response"],
        platforms: ["software-system"],
        world: ["controlled"],
        scoringEvidence: ["trajectory", "final-state"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Direct τ² adapter",
        adapter("tau2"),
        "Airline and retail oracle/empty paths only. Live user-model and external agent methods are not implemented.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Offline environment and scorer calibration passed; no live simulated-user or model quality claim.",
      "docs/tasks/20261105-sample-tau2.md",
    ),
    suites: ["Airline", "Retail"],
  },
  {
    id: "terminal-bench-science",
    name: "Terminal-Bench Science",
    description:
      "Perform scientific tasks in terminal workspaces with task-owned environments and verifiers.",
    taxonomyGroups: [
      group("Scientific terminal tasks", {
        ...workspace,
        domains: ["science"],
        taskTypes: ["analysis", "experimentation"],
        scoringEvidence: ["artifact"],
      }),
    ],
    integrations: [
      route(
        "Harbor format",
        "docs/tasks/20261010-harbor-verifier-modes.md",
        "Task directories, compose services and separate/shared verifiers; individual task conditions still apply.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Reference/empty samples checked. Score parity with official Harbor execution remains unverified.",
      "docs/tasks/20261010-harbor-verifier-modes.md",
    ),
    suites: ["Science task catalog"],
  },
  {
    id: "terminal-bench-4",
    name: "Terminal-Bench 4.0",
    description:
      "Complete terminal tasks with their own environments, dependencies and executable verification.",
    taxonomyGroups: [group("Terminal tasks", { ...workspace, scoringEvidence: ["artifact"] })],
    integrations: [
      route(
        "Harbor format",
        "docs/tasks/20261010-harbor-sidecars.md",
        "Supported task subset includes compose services; unsupported task conditions remain explicit.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Reference/empty samples checked. Coverage is partial and official-runner score parity is unverified.",
      "docs/tasks/20261010-harbor-sidecars.md",
    ),
    suites: ["4.0 task catalog (supported subset)"],
  },
  {
    id: "textarena",
    name: "TextArena",
    description:
      "Play text-based single-player games using the native game rules and terminal reward.",
    taxonomyGroups: [
      group("Single-player games", {
        domains: ["games"],
        taskTypes: ["gameplay"],
        modalities: ["text"],
        platforms: ["software-system"],
        world: ["controlled"],
        feedback: ["step"],
        participants: [],
        scoringEvidence: ["final-state"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Harbor TextArena conversion",
        "docs/tasks/20261105-samples-c1-c7.md",
        "38 single-player games with reference solutions; multiplayer and Elo ratings are outside this integration.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Four game families passed reference/empty checks under the converted protocol.",
      "docs/tasks/20261105-samples-c1-c7.md",
    ),
    suites: ["Single-player reference-supported games"],
  },
  {
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
  },
  {
    id: "rle-bench",
    name: "RLE-Bench",
    description: "Evaluate coding agents on robotic engineering, control and design tasks.",
    taxonomyGroups: [
      group("Robotic engineering workflows", {
        ...workspace,
        domains: ["robotics"],
        taskTypes: ["implementation", "experimentation", "optimization"],
        targets: ["planning", "tool-use", "control"],
        platforms: ["simulation"],
        world: ["controlled"],
        scoringEvidence: ["artifact"],
        scoringMethods: ["execution-test"],
      }),
    ],
    integrations: [
      route(
        "Native Harbor bridge",
        adapter("rle-bench"),
        "All 51 workflows remain visible; tasks 07 and 08 use the supported Harbor subset. Task 09 lacks native grader isolation; other unsupported runtime conditions remain explicit.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native empty/reference calibration passed on task08; saved output from a provider-interrupted Agent run was independently graded. Task07 and full-suite equivalence remain unverified.",
      "docs/tasks/20261110-embodied-harness-benchmarks.md",
    ),
    suites: ["Robot perception", "Policy learning", "Control", "Robot design"],
  },
  {
    id: "embodied-clbench",
    name: "EmbodiedCLBench",
    description: "Evaluate embodied agents and experience reuse across native task sequences.",
    taxonomyGroups: [
      group("Basic and zero-shot episodes", {
        domains: ["robotics"],
        taskTypes: ["navigation", "manipulation"],
        targets: ["planning", "tool-use", "perception-grounding"],
        modalities: ["text", "image"],
        interfaces: ["tool-api"],
        platforms: ["simulation"],
        world: ["controlled"],
        feedback: ["step"],
        participants: [],
        scoringEvidence: ["trajectory", "final-state"],
        scoringMethods: ["rule-check"],
      }),
      group("In-context continual sequences", {
        domains: ["robotics"],
        taskTypes: ["navigation", "manipulation"],
        targets: [
          "memory",
          "learning-adaptation",
          "generalization",
          "planning",
          "tool-use",
          "perception-grounding",
        ],
        modalities: ["text", "image"],
        interfaces: ["tool-api"],
        platforms: ["simulation"],
        world: ["controlled"],
        feedback: ["step"],
        participants: [],
        scoringEvidence: ["trajectory", "final-state"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Native sequence MCP adapter",
        adapter("embodied-clbench"),
        "Basic, zero-shot and complete in-context sequences preserve native images, tools and grading. Skill-summary sessions remain unsupported.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "A native basic task and complete in-context sequence passed reference/empty and real visual CLI Agent checks. Full-suite parity is unverified.",
      "docs/tasks/20261110-embodied-harness-benchmarks.md",
    ),
    suites: ["Basic", "Zero-shot", "In-context continual learning"],
  },
  {
    id: "embodiedlab",
    name: "EmbodiedLab",
    description:
      "Evaluate agents performing robot-controlled scientific experiments and submitting evidenced results.",
    taxonomyGroups: [
      group("Scientific experiments with T0 robot control", {
        domains: ["science", "robotics"],
        taskTypes: ["experimentation", "analysis", "manipulation"],
        targets: ["knowledge", "tool-use", "control"],
        modalities: ["text", "image", "structured-data"],
        interfaces: ["terminal", "file-edit", "physical-control"],
        platforms: ["simulation"],
        world: ["controlled"],
        feedback: ["step"],
        participants: [],
        scoringEvidence: ["artifact", "trajectory"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Native experiment service adapter",
        adapter("embodiedlab"),
        "30 native experiments through the T0 public robot API and private native grader; T1 services and unreleased T2 remain unsupported. Requires Isaac Sim 6.0.1.",
      ),
    ],
    verification: checked(
      "pending-calibration",
      "Images and native CPU dependencies were checked. Real startup detected an incompatible RTX runtime; experiment calibration requires a compatible environment.",
      "docs/tasks/20261110-embodied-harness-benchmarks.md",
    ),
    suites: ["Mechanics", "Circuits", "Optics", "Thermal physics", "Chemistry"],
  },
  {
    id: "miniwob",
    name: "MiniWoB++",
    description:
      "Complete browser interaction tasks from screenshots and native task instructions.",
    taxonomyGroups: [
      group("BrowserGym / CUA-Lite tasks", {
        ...browser,
        world: ["controlled"],
        scoringEvidence: ["final-state"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "BrowserGym adapter",
        adapter("browsergym"),
        "125 tasks with external/empty methods and GUI-capable CLI agents.",
      ),
      route(
        "CUA-Lite adapter",
        adapter("cua-lite"),
        "The same MiniWoB family through a separate screenshot-only recipe; CLI execution is restricted to calibrated tasks.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native empty checks and selected screenshot-only agent tasks passed. Recipes and step budgets remain separate.",
      "docs/tasks/20261104-p6-cli-agent-bridge.md",
    ),
    suites: ["MiniWoB++ task catalog"],
  },
  {
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
      "pending-calibration",
      "Subset and evaluator boundaries reviewed; positive model calibration is still pending.",
      adapter("cua-lite"),
    ),
    suites: ["Five reviewed read-only tasks"],
  },
  {
    id: "online-mind2web",
    name: "Online-Mind2Web",
    description:
      "Retrieve information from live websites through the native browser and terminal evaluator.",
    taxonomyGroups: [
      group("Reviewed live-web subset", {
        ...browser,
        taskTypes: ["retrieval"],
        world: ["live"],
        scoringEvidence: ["response", "trajectory"],
        scoringMethods: ["model-judge"],
      }),
    ],
    integrations: [
      route(
        "CUA-Lite adapter",
        adapter("cua-lite"),
        "Five reviewed read-only tasks; original backend and judge dependencies required. Live website availability is not guaranteed.",
      ),
    ],
    verification: checked(
      "pending-calibration",
      "Subset and evaluator boundaries reviewed; positive model calibration is still pending.",
      adapter("cua-lite"),
    ),
    suites: ["Five reviewed read-only tasks"],
  },
  {
    id: "cua-bench",
    name: "Cua Bench",
    description:
      "Complete basic desktop tasks using the original task variants and evaluation hooks.",
    taxonomyGroups: [
      group("Basic desktop tasks", {
        ...browser,
        platforms: ["desktop"],
        world: ["controlled"],
        scoringEvidence: ["final-state"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "Cua Bench adapter",
        adapter("cua-bench"),
        "68 basic Linux variants mapped; KiCad and workflow variants remain unsupported.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Five basic task families passed native empty/reference checks. General agents and remaining variants are not calibrated.",
      adapter("cua-bench"),
    ),
    suites: ["cua-bench-basic (Linux)"],
  },
  {
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
      "pending-calibration",
      "Adapter fixtures exist; real native emulator calibration has not run.",
      adapter("mobileworld"),
    ),
    suites: ["Original supported mobile task classes"],
  },
  {
    id: "osworld",
    name: "OSWorld-V2",
    description: "Run desktop computer-use tasks with the release's original runner and evaluator.",
    taxonomyGroups: [
      group("Desktop task adapter", {
        ...browser,
        platforms: ["desktop"],
        scoringEvidence: ["final-state"],
        scoringMethods: ["rule-check"],
      }),
    ],
    integrations: [
      route(
        "OSWorld-V2 adapter",
        adapter("osworld-v2"),
        "Original release catalog retained; gated files, VM images and external service conditions remain explicit.",
      ),
    ],
    verification: checked(
      "pending-calibration",
      "Adapter fixtures exist; real KVM-backed calibration has not run.",
      adapter("osworld-v2"),
    ),
    suites: ["V2 release task catalog"],
  },
  {
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
  },
  {
    id: "libero-plus",
    name: "LIBERO-Plus",
    description:
      "Measure manipulation robustness across 10,030 variants and seven perturbation categories.",
    taxonomyGroups: [group("LIBERO robustness", native)],
    integrations: [
      nativeRoute(
        "Four native suites, with one official initial state per perturbation variant.",
        "examples/bench-adapters/embodied/LIBERO-PLUS.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "The full reset catalog was checked. Native samples span all seven perturbations, and two OFT episodes passed.",
      nativeDocs,
    ),
    suites: ["Spatial", "Object", "Goal", "Long"],
  },
  {
    id: "vlabench",
    name: "VLABench",
    description:
      "Evaluate language-conditioned Franka manipulation with fixed scenes and open cross-task evaluation.",
    taxonomyGroups: [group("Language-conditioned manipulation", native)],
    integrations: [
      nativeRoute(
        "All five published fixed tracks and the released native task registry for seeded cross-task evaluation.",
        "examples/bench-adapters/embodied/VLABENCH.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "The released catalogs and samples across all six tracks were checked. An OpenWAM episode passed.",
      nativeDocs,
    ),
    suites: [
      "In distribution",
      "Cross category",
      "Common sense",
      "Semantic instruction",
      "Cross task",
      "Unseen texture",
    ],
  },
  {
    id: "simpler-env",
    name: "SimplerEnv",
    description:
      "Evaluate robot manipulation with Google Robot and WidowX in fixed simulation recipes and scene grids.",
    taxonomyGroups: [group("Native robot tasks", native)],
    integrations: [
      nativeRoute(
        "GR00T recipes, prepackaged tasks, visual matching and variant aggregation; policy termination is available on fixed grids.",
        "examples/bench-adapters/embodied/SIMPLER.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native reset/render/control checks and selected GR00T episodes passed. Not every grid has real-model validation.",
      nativeDocs,
    ),
    suites: ["Google Robot", "WidowX", "Prepackaged", "Visual matching", "Variant aggregation"],
  },
  {
    id: "robocasa-v02",
    name: "RoboCasa v0.2",
    description: "Evaluate the original RoboCasa atomic kitchen manipulation tasks.",
    taxonomyGroups: [group("Original kitchen manipulation", native)],
    integrations: [
      nativeRoute(
        "24 atomic tasks with held-out object instances, fixed kitchen layouts and PandaOmron arm control.",
        "examples/bench-adapters/embodied/ROBOCASA-V02.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "All 24 tasks passed native CPU checks. A fixed-action replay matched the v0.2 environment.",
      "docs/tasks/20261109-robocasa-v02.md",
    ),
    suites: ["Atomic-24"],
  },
  {
    id: "robocasa365",
    name: "RoboCasa365",
    description:
      "Evaluate kitchen manipulation across atomic, composite, seen, unseen and lifelong task scopes.",
    taxonomyGroups: [group("Kitchen manipulation", native)],
    integrations: [
      nativeRoute(
        "Pinned full catalog and Lifelong scopes; π₀.₅ and GR00T N1.5 recipes use different runtime and success conditions.",
        "examples/bench-adapters/embodied/ROBOCASA365.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native catalog checks and selected real-policy episodes passed; full catalog model evaluation is not implied.",
      nativeDocs,
    ),
    suites: [
      "Atomic-Seen",
      "Composite-Seen",
      "Composite-Unseen",
      "Full pinned catalog",
      "Lifelong",
    ],
  },
  {
    id: "robotwin",
    name: "RoboTwin 2.0",
    description:
      "Evaluate dual-arm manipulation with clean and randomized scenes under native control protocols.",
    taxonomyGroups: [group("Dual-arm manipulation", native)],
    integrations: [
      nativeRoute(
        "Clean and Randomized catalogs; joint-control and Cartesian policies are separate protocols.",
        "examples/bench-adapters/embodied/ROBOTWIN.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native catalog/control checks and selected π₀.₅ / X-VLA episodes passed. Full-suite score equivalence remains unverified.",
      nativeDocs,
    ),
    suites: ["Clean", "Randomized", "Cartesian Clean", "Cartesian Randomized"],
  },
  {
    id: "maniskill3",
    name: "ManiSkill3",
    description:
      "Evaluate manipulation tasks across a native tabletop catalog and the RLinf Plate-25 recipe.",
    taxonomyGroups: [
      group("Native manipulation tasks", { ...native, modalities: ["text", "image"] }),
    ],
    integrations: [
      nativeRoute(
        "Plate-25 and available tabletop robot/controller profiles; two asset-backed tasks remain unverified.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Native tabletop checks and selected OFT Plate-25 episodes passed. AssemblingKits and TurnFaucet still require asset validation.",
      "docs/tasks/20261109-embodied-benchmark-coverage.md",
    ),
    suites: ["Plate-25 (RLinf)", "Native tabletop profiles"],
  },
  {
    id: "rlbench",
    name: "RLBench",
    description:
      "Evaluate Panda manipulation in CoppeliaSim with seeded tasks and fixed test demonstrations.",
    taxonomyGroups: [group("Native manipulation tasks", native)],
    integrations: [
      nativeRoute(
        "MT100 with seeded variations and a separate RVT 18-task test suite with frozen initial states.",
        "examples/bench-adapters/embodied/RLBENCH.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "MT100 and RVT both ran with native CPU rendering. A fixed RVT replay matched the upstream environment.",
      "docs/tasks/20261109-rlbench.md",
    ),
    suites: ["MT100", "RVT test (18 tasks)"],
  },
  {
    id: "metaworld",
    name: "Meta-World",
    description: "Evaluate Sawyer manipulation across the native MT50 task set.",
    taxonomyGroups: [group("MT50 manipulation", native)],
    integrations: [
      nativeRoute(
        "MT50 catalog through the pinned RLinf reference; keeps native task instructions and control conditions.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "All MT50 tasks passed native reset/render/control checks; selected π₀.₅ episodes passed independent verification.",
      "docs/tasks/20261108-embodied-native-expansion.md",
    ),
    suites: ["MT50"],
  },
  {
    id: "calvin",
    name: "CALVIN",
    description:
      "Evaluate chains of five language instructions in the held-out scene D environment.",
    taxonomyGroups: [group("ABC→D instruction sequences", native)],
    integrations: [
      nativeRoute(
        "Frozen catalog of 1,000 native instruction sequences; benchmark registration is independent of policy weights.",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Selected real π₀.₅ sequences, per-subtask scoring and independent verification checked; full-suite evaluation remains unverified.",
      "docs/tasks/20261108-embodied-calvin-xvla.md",
    ),
    suites: ["ABC→D"],
  },

  {
    id: "robomimic",
    name: "RoboMimic",
    description:
      "Evaluate policies on the five classic proficient-human manipulation tasks in robosuite.",
    taxonomyGroups: [group("Demonstration-conditioned manipulation", native)],
    integrations: [
      nativeRoute(
        "PH v1.5.1 environments with separate low-dimensional and RGB policy profiles.",
        "examples/bench-adapters/embodied/ROBOMIMIC.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "All five tasks passed native low-dimensional and RGB checks. Two published demonstrations replayed successfully.",
      "docs/tasks/20261110-robomimic.md",
    ),
    suites: ["Proficient Human (PH)", "Low-dimensional", "RGB"],
  },
  {
    id: "vima-bench",
    name: "VIMA-Bench",
    description:
      "Evaluate multimodal prompt following and generalization with native PyBullet manipulation primitives.",
    taxonomyGroups: [group("Multimodal manipulation", native)],
    integrations: [
      nativeRoute(
        "Four official test partitions with multimodal prompt assets and independently served VIMA.",
        "examples/bench-adapters/embodied/VIMA-BENCH.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "All four test partitions passed native checks. Selected VIMA 20M episodes passed independent verification.",
      "docs/tasks/20261110-vima-bench.md",
    ),
    suites: ["Placement", "Combinatorial", "Novel object", "Novel task"],
  },

  {
    id: "robodojo",
    name: "RoboDojo",
    description: "Evaluate dual-arm manipulation in the official Isaac Sim task environments.",
    taxonomyGroups: [group("Native simulated manipulation", native)],
    integrations: [
      nativeRoute(
        "Frozen native layouts, joint controls and process scores; requires the pinned Isaac Sim runtime and assets.",
        "examples/bench-adapters/embodied/ROBODOJO.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Two full-horizon native hold-control episodes, CPU verification and rescore checked. Trained-policy, positive-oracle and full-suite parity are unverified.",
      "docs/tasks/20261109-robodojo-robolab.md",
    ),
    suites: ["Native simulation tasks"],
  },
  {
    id: "robolab",
    name: "RoboLab",
    description:
      "Evaluate DROID manipulation in the official high-fidelity Isaac Lab environments.",
    taxonomyGroups: [group("Native DROID manipulation", native)],
    integrations: [
      nativeRoute(
        "Original task catalog, joint-position actions and native termination results; requires the pinned Isaac Sim runtime and assets.",
        "examples/bench-adapters/embodied/ROBOLAB.md",
      ),
    ],
    verification: checked(
      "sample-checked",
      "Two native hold-control episodes, CPU verification and rescore checked; an official successful replay was checked separately. Trained-policy and full-suite parity are unverified.",
      "docs/tasks/20261109-robodojo-robolab.md",
    ),
    suites: ["Native DROID tasks"],
  },
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
