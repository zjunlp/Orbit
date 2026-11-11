// Shared product-catalog helpers and taxonomy presets for the per-family entries.
import type { BenchTaxonomy } from "../../contracts/index.ts";

export const source = (path: string) => `https://github.com/zjunlp/Orbit/blob/main/${path}`;
export const adapter = (name: string) => `examples/bench-adapters/${name}/README.md`;
export const route = (name: string, path: string, scope: string) => ({
  name,
  url: source(path),
  scope,
});
export const checked = (detail: string, path: string) => ({ detail, url: source(path) });
export const group = (label: string, taxonomy: BenchTaxonomy) => ({ label, taxonomy });

export const workspace: BenchTaxonomy = {
  modalities: ["text"],
  interfaces: ["terminal", "file-edit"],
  platforms: ["software-system"],
  feedback: ["step"],
};
export const browser: BenchTaxonomy = {
  modalities: ["text", "image"],
  interfaces: ["gui"],
  platforms: ["browser"],
  feedback: ["step"],
  participants: [],
};
export const native: BenchTaxonomy = {
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
export const nativeDocs = "docs/guides/embodied-compatibility.md";
export const nativeRoute = (scope: string, path = adapter("embodied")) =>
  route("Native policy adapter", path, scope);
