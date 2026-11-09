// Discovery metadata only; execution requirements and scoring contracts remain authoritative.
export const TAXONOMY_VALUES = {
  domains: [
    "general-knowledge",
    "software",
    "machine-learning",
    "mathematics",
    "science",
    "healthcare",
    "finance",
    "law-public-affairs",
    "business-services",
    "media",
    "robotics",
    "games",
  ],
  taskTypes: [
    "answering",
    "retrieval",
    "generation",
    "information-processing",
    "analysis",
    "implementation",
    "repair",
    "training",
    "optimization",
    "business-operation",
    "experimentation",
    "navigation",
    "manipulation",
    "gameplay",
  ],
  targets: [
    "knowledge",
    "reasoning",
    "planning",
    "tool-use",
    "memory",
    "perception-grounding",
    "collaboration",
    "control",
    "learning-adaptation",
    "instruction-following",
    "robustness",
    "generalization",
    "safety",
    "efficiency",
  ],
  modalities: ["text", "image", "video", "audio", "structured-data"],
  interfaces: ["response", "file-edit", "terminal", "tool-api", "gui", "physical-control"],
  platforms: ["software-system", "browser", "desktop", "mobile", "simulation", "physical-device"],
  world: ["controlled", "live"],
  feedback: ["none", "step", "realtime"],
  participants: ["simulated-user", "human-user", "teammate", "opponent"],
  scoringEvidence: ["response", "artifact", "final-state", "trajectory"],
  scoringMethods: [
    "rule-check",
    "execution-test",
    "model-judge",
    "human-review",
    "model-statistics",
  ],
} as const;

export type TaxonomyField = keyof typeof TAXONOMY_VALUES;
export type TaxonomyDescriptor = Partial<Record<TaxonomyField, readonly string[] | null>>;
export type TaxonomyFilters = Partial<Record<TaxonomyField, readonly string[]>>;

function field(key: TaxonomyField, label: string, group: string, labels: string[]) {
  return {
    label,
    group,
    values: TAXONOMY_VALUES[key].map((value, i) => ({ value, label: labels[i] ?? value })),
  };
}

export const TAXONOMY_FIELDS = {
  domains: field("domains", "Domain", "domain", [
    "General knowledge & everyday life",
    "Software engineering",
    "Machine learning",
    "Mathematics & formal systems",
    "Natural science",
    "Healthcare",
    "Finance & economics",
    "Law & public affairs",
    "Business & office",
    "Media & creativity",
    "Robotics & physical systems",
    "Games",
  ]),
  taskTypes: field("taskTypes", "Task type", "task", [
    "Question answering",
    "Retrieval",
    "Content generation",
    "Information processing",
    "Analysis & diagnosis",
    "Implementation",
    "Repair",
    "Training & adaptation",
    "Optimization",
    "Business operations",
    "Experimentation & reproduction",
    "Navigation",
    "Manipulation",
    "Gameplay",
  ]),
  targets: field("targets", "Evaluation target", "target", [
    "Knowledge use",
    "Reasoning",
    "Planning",
    "Tool use",
    "Memory",
    "Perception & grounding",
    "Interaction & collaboration",
    "Control",
    "Learning & adaptation",
    "Instruction following",
    "Reliability & robustness",
    "Generalization",
    "Safety",
    "Efficiency",
  ]),
  modalities: field("modalities", "Observation", "interface", [
    "Text",
    "Image",
    "Video",
    "Audio",
    "Structured data & state",
  ]),
  interfaces: field("interfaces", "Action interface", "interface", [
    "Response",
    "File editing",
    "Terminal & code execution",
    "Semantic tools",
    "GUI interaction",
    "Physical / simulated control",
  ]),
  platforms: field("platforms", "Environment", "environment", [
    "Software / service",
    "Browser",
    "Desktop",
    "Mobile",
    "Physical simulation",
    "Physical device",
  ]),
  world: field("world", "World conditions", "environment", ["Controlled", "Live external world"]),
  feedback: field("feedback", "Interaction", "environment", [
    "No interactive feedback",
    "Synchronous steps",
    "Continuous real time",
  ]),
  participants: field("participants", "Other participants", "environment", [
    "Simulated user",
    "Human user",
    "Teammate",
    "Opponent",
  ]),
  scoringEvidence: field("scoringEvidence", "Scoring evidence", "scoring", [
    "Response",
    "Artifact",
    "Final state",
    "Trajectory",
  ]),
  scoringMethods: field("scoringMethods", "Judging method", "scoring", [
    "Rule / reference check",
    "Execution tests",
    "Model judge",
    "Human review",
    "Model probability statistics",
  ]),
} satisfies Record<TaxonomyField, ReturnType<typeof field>>;

export const TAXONOMY_GROUPS = [
  { id: "domain", label: "Domain", question: "What is the task about?", fields: ["domains"] },
  {
    id: "task",
    label: "Task type",
    question: "What work must be completed?",
    fields: ["taskTypes"],
  },
  {
    id: "target",
    label: "Evaluation target",
    question: "What capability or quality is measured?",
    fields: ["targets"],
  },
  {
    id: "interface",
    label: "Interface & modality",
    question: "What can the system observe and do?",
    fields: ["modalities", "interfaces"],
  },
  {
    id: "environment",
    label: "Environment & interaction",
    question: "Under what conditions does it act?",
    fields: ["platforms", "world", "feedback", "participants"],
  },
  {
    id: "scoring",
    label: "Scoring",
    question: "What evidence determines the result?",
    fields: ["scoringEvidence", "scoringMethods"],
  },
] as const;

/** Call on one task's resolved descriptor, never a benchmark-wide union. */
export function taxonomyMatches(taxonomy: TaxonomyDescriptor, filters: TaxonomyFilters): boolean {
  return (Object.keys(filters) as TaxonomyField[]).every((key) => {
    const selected = filters[key];
    if (!selected?.length) return true;
    const values = taxonomy[key];
    return selected.some((value) =>
      value === "unlabeled"
        ? values == null
        : value === "__none__"
          ? values?.length === 0
          : values?.includes(value),
    );
  });
}
