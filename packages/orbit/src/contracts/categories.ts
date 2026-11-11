// Deprecated benchmark integration categories (design §9.10), read for compatibility. No imports, so the Web bundle
// can use them at runtime (`@zjunlp/orbit/categories`); the zod schemas live in bench.ts.

/**
 * Deprecated integration categories (design §9.10): what the evaluated subject is and how it
 * interacts with the task. Environment, scoring and world are profiles within a category.
 */
export const BENCH_CATEGORIES = [
  "fixed-input",
  "agent-workspace",
  "tool-workflow",
  "user-session",
  "gui",
  "embodied-policy",
  "game",
] as const;
export type BenchCategory = (typeof BENCH_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<BenchCategory, string> = {
  "fixed-input": "C1 Fixed input",
  "agent-workspace": "C2 Agent workspace",
  "tool-workflow": "C3 Tool workflow",
  "user-session": "C4 Simulated user",
  gui: "C5 GUI",
  "embodied-policy": "C6 Embodied policy",
  game: "C7 Game",
};

/** Profiles each category admits (a closed vocabulary, so the same condition has one name). */
export const CATEGORY_PROFILES: Record<BenchCategory, readonly string[]> = {
  "fixed-input": ["generate", "likelihood", "exec-test", "judge", "image", "audio", "grounding"],
  "agent-workspace": [
    "repo-patch",
    "terminal",
    "ml-experiment",
    "research-report",
    "embodied-program",
    "embodied-live",
    "judge",
  ],
  "tool-workflow": ["local-state", "remote-service", "search", "mcp", "live", "judge"],
  "user-session": ["text", "voice", "single-control", "dual-control"],
  gui: [
    "browser",
    "desktop",
    "mobile",
    "fixture",
    "mirrored",
    "live",
    "coordinate",
    "element-tree",
    "native-code",
    "judge",
  ],
  "embodied-policy": ["sim", "real", "sync", "realtime", "step", "chunk", "goal", "long-horizon"],
  game: ["single-player", "turn-based", "simultaneous", "competitive", "cooperative"],
};

/** The category of a capability declaration; older ones only had a `kind`. */
export function benchCategory(c: { category?: BenchCategory; kind?: string } | undefined) {
  if (c?.category) return c.category;
  return c?.kind && ["browser", "desktop", "mobile"].includes(c.kind) ? "gui" : null;
}

/**
 * Subject domains (design §9.16): what a benchmark's tasks are about, independent of how the subject
 * interacts with them (the category). A benchmark has one or more; values outside this vocabulary
 * (an adapter's own sub-domains, such as tau2's `airline`) are kept as tags and not counted.
 */
export const BENCH_DOMAINS = [
  "science",
  "software",
  "machine-learning",
  "data-analysis",
  "gui-web",
  "embodied",
  "games",
  "conversation",
  "knowledge",
] as const;
export type BenchDomain = (typeof BENCH_DOMAINS)[number];

export const DOMAIN_LABELS: Record<BenchDomain, string> = {
  science: "Science",
  software: "Software",
  "machine-learning": "Machine learning",
  "data-analysis": "Data analysis",
  "gui-web": "GUI & web",
  embodied: "Embodied",
  games: "Games",
  conversation: "Conversation",
  knowledge: "Knowledge & reasoning",
};

/** Declared domains split into the vocabulary's and the other tags, each in declared order. */
export function splitDomains(declared: readonly string[]): {
  domains: BenchDomain[];
  tags: string[];
} {
  const known = new Set<string>(BENCH_DOMAINS);
  const domains = [...new Set(declared.filter((d) => known.has(d)))] as BenchDomain[];
  const tags = [...new Set(declared.filter((d) => !known.has(d)))];
  return { domains, tags };
}
