// Every page of the Web UI in one table: its address, rail entry, `g x` shortcut and palette entry.
// App.tsx maps each route name to its component; the type checker keeps that map complete.
import {
  IconBot,
  IconChip,
  IconCompare,
  IconDashboard,
  IconFlask,
  IconLayers,
  IconLibrary,
  IconRuns,
  IconSettings,
} from "./components/icons.tsx";

type Icon = (p: { size?: number }) => React.ReactNode;

export interface PageDef {
  name: string;
  path: string;
  label: string;
  /** Second key of the `g x` shortcut. */
  key: string;
  icon: Icon;
  /** Where the rail shows it; pages without one are reached by palette and shortcut only. */
  rail?: "top" | "Evaluate" | "Operate" | "bottom";
  /** Label in the command palette, when longer than the rail label. */
  title?: string;
  /** Words the palette matches. */
  terms: string;
  /** Other addresses that highlight this rail entry. */
  covers?: RegExp;
}

export const PAGES = [
  {
    name: "overview",
    path: "/",
    label: "Overview",
    key: "o",
    icon: IconDashboard,
    rail: "top",
    terms: "overview home",
  },
  {
    name: "benchmarks",
    path: "/benchmarks",
    label: "Benchmarks",
    key: "b",
    icon: IconLibrary,
    rail: "Evaluate",
    terms: "benchmarks catalog taxonomy calibration",
  },
  {
    name: "agents",
    path: "/agents",
    label: "Agents",
    key: "a",
    icon: IconBot,
    rail: "Evaluate",
    terms: "agents harness codex claude",
  },
  {
    name: "configurations",
    path: "/configurations",
    label: "Configurations",
    key: "m",
    icon: IconLayers,
    rail: "Evaluate",
    title: "Evaluation configurations",
    terms: "evaluation configurations models reasoning effort versions",
  },
  {
    name: "bench",
    path: "/bench",
    label: "Evaluations",
    key: "e",
    icon: IconFlask,
    rail: "Evaluate",
    terms: "evaluations bench jobs trials",
    covers: /^\/bench\//,
  },
  {
    name: "runs",
    path: "/runs",
    label: "Runs",
    key: "r",
    icon: IconRuns,
    rail: "Operate",
    terms: "runs",
    covers: /^\/(runs\/|compare$)/,
  },
  {
    name: "compare",
    path: "/compare",
    label: "Compare",
    key: "c",
    icon: IconCompare,
    title: "Compare runs",
    terms: "compare",
  },
  {
    name: "resources",
    path: "/resources",
    label: "Resources",
    key: "s",
    icon: IconChip,
    rail: "Operate",
    terms: "resources gpu",
  },
  {
    name: "settings",
    path: "/settings",
    label: "Settings",
    key: "p",
    icon: IconSettings,
    rail: "bottom",
    terms: "settings auth profiles notifications",
  },
] as const satisfies readonly PageDef[];

/** Pages below the top level; matched before the top-level pages, in this order. */
const DETAIL_ROUTES = [
  { name: "run", pattern: /^\/runs\/([^/]+)$/ },
  { name: "trial", pattern: /^\/bench\/([^/]+)\/trials\/([^/]+)$/ },
  { name: "benchCompare", pattern: /^\/bench\/compare$/ },
  { name: "benchNew", pattern: /^\/bench\/new$/ },
  { name: "benchJob", pattern: /^\/bench\/([^/]+)$/ },
] as const;

export type RouteName = (typeof PAGES)[number]["name"] | (typeof DETAIL_ROUTES)[number]["name"];

/** The page at an address and its raw (still encoded) path parameters; null for unknown paths. */
export function matchRoute(path: string): { name: RouteName; params: string[] } | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  for (const r of DETAIL_ROUTES) {
    const m = r.pattern.exec(normalized);
    if (m) return { name: r.name, params: m.slice(1) };
  }
  const page = PAGES.find((p) => p.path === normalized);
  return page ? { name: page.name, params: [] } : null;
}

/** Whether a rail entry is the current page or covers it. */
export const railActive = (page: PageDef, path: string) => {
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === page.path || Boolean(page.covers?.test(normalized));
};

/** `g x` shortcuts for the help overlay, a few pages per row. */
export function pageShortcuts(perRow = 5): [string, string][] {
  const rows: [string, string][] = [];
  for (let i = 0; i < PAGES.length; i += perRow) {
    const chunk = PAGES.slice(i, i + perRow);
    rows.push([
      chunk.map((p) => `g ${p.key}`).join(" · "),
      `Go to ${chunk.map((p) => p.label).join(" · ")}`,
    ]);
  }
  return rows;
}
