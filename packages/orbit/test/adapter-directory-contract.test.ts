import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const adaptersRoot = fileURLToPath(new URL("../../../examples/bench-adapters/", import.meta.url));
const catalogRoot = fileURLToPath(new URL("../src/bench/benchmarks/", import.meta.url));

const adapterDirs = readdirSync(adaptersRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const catalogSource = readdirSync(catalogRoot)
  .filter((f) => f.endsWith(".ts") && f !== "shared.ts" && f !== "index.ts")
  .map((f) => readFileSync(catalogRoot + f, "utf8"))
  .join("\n");

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Adapters whose tests live with the shared code they exercise rather than in their own directory.
 * The named file must exist, so the exception cannot rot into a silent gap.
 */
const TESTS_ELSEWHERE: Record<string, string> = {
  // The embodied adapter is a thin protocol shim over the shared Python SDK, tested as a package.
  embodied: "examples/sdk/orbit_embodied/test_adapter.py",
  // The Harbor suite adapter imports the built-in harbor module; its tests drive that adapter directly.
  "harbor-suites": "packages/orbit/test/benchmark-gaps.test.ts",
};

/** The contract every adapter directory must satisfy (docs/guides/bench-adapter.md §0). */
function check(name: string): string[] {
  const dir = adaptersRoot + name + "/";
  const files = readdirSync(dir);
  const problems: string[] = [];
  if (!files.some((f) => f === "adapter.py" || f === "adapter.ts"))
    problems.push(`${name}: no adapter.py or adapter.ts`);
  if (!files.includes("README.md")) problems.push(`${name}: no README.md`);
  const hasTests =
    files.some((f) => /^test_.*\.py$/.test(f)) || files.some((f) => /\.test\.ts$/.test(f));
  const elsewhere = TESTS_ELSEWHERE[name];
  if (elsewhere) {
    if (!existsSync(repoRoot + elsewhere))
      problems.push(`${name}: declared tests at ${elsewhere} do not exist`);
  } else if (!hasTests) {
    problems.push(`${name}: no test_adapter.py or *.test.ts`);
  }
  return problems;
}

it("ships every adapter directory with an entry point, a README and tests", () => {
  expect(adapterDirs.length).toBeGreaterThan(0);
  expect(adapterDirs.flatMap(check)).toEqual([]);
});

it("links every adapter directory from exactly one place in the product catalog", () => {
  const unlinked = adapterDirs.filter(
    (name) =>
      !catalogSource.includes(`adapter("${name}")`) &&
      !catalogSource.includes(`bench-adapters/${name}/`),
  );
  expect(unlinked).toEqual([]);
});

it("has no product-catalog route pointing at a directory that does not exist", () => {
  const referenced = new Set<string>();
  for (const m of catalogSource.matchAll(/adapter\("([^"]+)"\)/g)) referenced.add(m[1] as string);
  for (const m of catalogSource.matchAll(/examples\/bench-adapters\/([^/"]+)\//g))
    referenced.add(m[1] as string);
  expect([...referenced].filter((name) => !existsSync(adaptersRoot + name)).sort()).toEqual([]);
});

it("keeps the per-family files and the catalog index in step", () => {
  const files = readdirSync(catalogRoot)
    .filter((f) => f.endsWith(".ts") && f !== "shared.ts" && f !== "index.ts")
    .sort();
  const index = readFileSync(catalogRoot + "index.ts", "utf8");
  const missing = files.filter((f) => !index.includes(`from "./${f}"`));
  expect(missing).toEqual([]);
});
