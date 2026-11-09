import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { catalogTaxonomy, resolveTaxonomy } from "../src/bench/catalog.ts";
import { sameMethodSetup } from "../src/bench/consolidate.ts";
import { comparisonCondition } from "../src/bench/hub.ts";
import { registerBench } from "../src/cli/bench.ts";
import { OrbitClient } from "../src/client/index.ts";
import {
  BenchCapabilities,
  BenchJob,
  Benchmark,
  BenchTask,
  BenchTaxonomy,
  taxonomyMatches,
} from "../src/contracts/index.ts";

const benchmark = Benchmark.parse({
  name: "fixture",
  path: "/fixture",
  adapter: "harbor",
  createdAt: "",
  updatedAt: "",
});
const capabilities = BenchCapabilities.parse({
  category: "agent-workspace",
  profiles: ["terminal"],
  domains: ["science"],
  methods: ["empty"],
  conditions: {},
  scoreKind: "scalar",
  rescore: "evidence",
});
const task = (id: string, taxonomy?: object) =>
  BenchTask.parse({
    id,
    title: null,
    supported: true,
    reason: null,
    taxonomy,
  });

it("keeps same-task conjunctions when a collection has heterogeneous task descriptors", () => {
  const catalog = catalogTaxonomy(benchmark, capabilities, [
    task("a", { domains: ["science"], interfaces: ["terminal"] }),
    task("b", { domains: ["software"], interfaces: ["gui"] }),
    task("c", { domains: ["science"], interfaces: ["terminal"] }),
  ]);
  expect(catalog.taxonomy).toEqual({
    domains: ["science", "software"],
    interfaces: ["gui", "terminal"],
  });
  expect(catalog.taxonomyGroups?.map((g) => g.taskCount)).toEqual([2, 1]);
  const cross = { domains: ["science"], interfaces: ["gui"] };
  expect(catalog.taxonomyGroups?.some((g) => taxonomyMatches(g.taxonomy, cross))).toBe(false);
  expect(
    catalog.taxonomyGroups?.some((g) =>
      taxonomyMatches(g.taxonomy, { ...cross, domains: ["science", "software"] }),
    ),
  ).toBe(true);
});

it("lets task fields replace registration defaults without inheriting null or empty fields", () => {
  const b = {
    ...benchmark,
    labels: {
      taxonomy: BenchTaxonomy.parse({
        domains: ["finance"],
        taskTypes: ["analysis"],
        interfaces: ["terminal"],
        targets: ["reasoning"],
        participants: ["simulated-user"],
      }),
    },
  };
  const catalog = catalogTaxonomy(b, capabilities, [
    task("a", {
      domains: ["software"],
      targets: null,
      participants: [],
      interfaces: ["gui"],
    }),
  ]);
  expect(catalog.taxonomyGroups?.[0]?.taxonomy).toEqual({
    domains: ["software"],
    taskTypes: ["analysis"],
    interfaces: ["gui"],
    targets: null,
    participants: [],
  });
  expect(
    taxonomyMatches(catalog.taxonomyGroups?.[0]?.taxonomy ?? {}, { targets: ["unlabeled"] }),
  ).toBe(true);
  expect(
    taxonomyMatches(catalog.taxonomyGroups?.[0]?.taxonomy ?? {}, { participants: ["unlabeled"] }),
  ).toBe(false);
  expect(
    taxonomyMatches(catalog.taxonomyGroups?.[0]?.taxonomy ?? {}, { participants: ["__none__"] }),
  ).toBe(true);
  expect(resolveTaxonomy({ targets: ["reasoning"] }, { targets: undefined })).toEqual({
    targets: ["reasoning"],
  });
});

it("does not guess targets, task types or modalities from legacy integration categories", () => {
  expect(
    catalogTaxonomy(benchmark, { ...capabilities, domains: [] }, [task("a")]).taxonomy,
  ).toEqual({});
  expect(
    catalogTaxonomy(benchmark, { ...capabilities, domains: ["embodied", "knowledge", "gui-web"] }, [
      task("a"),
    ]).taxonomy,
  ).toEqual({ domains: ["robotics"] });
  expect(
    catalogTaxonomy(
      benchmark,
      { ...capabilities, domains: ["knowledge", "data-analysis", "constructor"] },
      [task("a")],
    ).taxonomy,
  ).toEqual({});
});

it("updates taxonomy through the CLI without dropping identity or legacy domain labels", async () => {
  const client = new OrbitClient({ url: "http://unused", token: "fixture", pid: 0 });
  const labels = { identity: { id: "fx", name: "Fixture" }, domains: ["science"] };
  vi.spyOn(client, "benchmarks").mockResolvedValue([{ ...benchmark, labels }]);
  const update = vi.spyOn(client, "benchLabel").mockResolvedValue(benchmark);
  const program = new Command();
  registerBench(program, async () => client, vi.fn());
  await program.parseAsync(
    ["bench", "label", "fixture", "--taxonomy", '{"targets":null,"participants":[]}'],
    { from: "user" },
  );
  expect(update).toHaveBeenCalledWith("fixture", {
    ...labels,
    taxonomy: { targets: null, participants: [] },
  });
});

it("preserves task domain tags and avoids inventing tasks before a listing exists", () => {
  const t = { ...task("a"), tags: { domain: "embodied" } };
  expect(catalogTaxonomy(benchmark, capabilities, [t]).taxonomy).toEqual({ domains: ["robotics"] });
  expect(catalogTaxonomy(benchmark, capabilities, null).taxonomyGroups).toEqual([
    { taxonomy: { domains: ["science"] }, taskCount: null },
  ]);
  expect(catalogTaxonomy(benchmark, capabilities, []).taxonomyGroups).toEqual([]);
});

it("rejects foreign taxonomy values and preserves missing, unknown and known-empty fields", () => {
  expect(BenchTaxonomy.parse({})).toEqual({});
  expect(BenchTaxonomy.parse({ targets: null, participants: [] })).toEqual({
    targets: null,
    participants: [],
  });
  expect(BenchTaxonomy.safeParse({ domains: ["harbor"] }).success).toBe(false);
  expect(BenchTaxonomy.safeParse({ adapter: "harbor" }).success).toBe(false);
  expect(BenchTaxonomy.safeParse({ scoringMethods: ["reward.txt"] }).success).toBe(false);
});

it("does not change method comparison or retry compatibility when only taxonomy changes", () => {
  const job = BenchJob.parse({
    id: "j",
    spec: { benchmark: "fixture", tasks: ["a"], methods: [{ name: "empty", agent: "empty" }] },
    state: "done",
    createdAt: "",
    endedAt: "",
    benchmarkSnapshot: benchmark,
    capabilities,
  });
  const changed = {
    ...job,
    capabilities: { ...capabilities, taxonomy: BenchTaxonomy.parse({ domains: ["robotics"] }) },
  };
  expect(comparisonCondition(changed)).toBe(comparisonCondition(job));
  expect(sameMethodSetup(job, changed)).toBe(true);
  const protocolChanged = {
    ...changed,
    capabilities: { ...changed.capabilities, conditions: { Interface: "different" } },
  };
  expect(comparisonCondition(protocolChanged)).not.toBe(comparisonCondition(job));
  expect(sameMethodSetup(job, protocolChanged)).toBe(false);
});
