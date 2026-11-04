// Benchmark integration categories (docs/integration-categories.md). No imports, so the Web bundle
// can use them at runtime (`@zjunlp/orbit/categories`); the zod schemas live in bench.ts.

/**
 * Integration categories (docs/integration-categories.md): what the evaluated subject is and how it
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
