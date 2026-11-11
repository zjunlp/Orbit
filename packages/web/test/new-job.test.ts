import type {
  BenchCapabilities,
  BenchJob,
  Benchmark,
  BenchTask,
  Method,
} from "@zjunlp/orbit/contracts";
import { describe, expect, it } from "vitest";
import {
  buildMethods,
  copiedMethods,
  type EvaluationFields,
  evaluationSpec,
  importMethods,
  methodDraft,
  registrationChanged,
  taskSubset,
  withLineage,
} from "../src/pages/bench/new-job.ts";

const caps: BenchCapabilities = {
  methods: ["external", "empty"],
  conditions: { observation: "screenshot", maxSteps: "20" },
  scoreKind: "binary",
  rescore: "evidence",
  requires: [],
};
const tasks: BenchTask[] = [
  { id: "click", title: null, supported: true, reason: null, tags: {} },
  { id: "type", title: null, supported: true, reason: null, tags: {} },
  { id: "unsupported", title: null, supported: false, reason: "Not implemented", tags: {} },
];
const empty: Method = { name: "empty", agent: "empty" };
const fields: EvaluationFields = {
  benchmark: "miniwob",
  tasks: ["click"],
  name: "GUI check",
  seeds: "3",
  timeout: "5",
  options: '{"setting":"value"}',
};
const registration: Benchmark = {
  name: "miniwob",
  adapter: "/adapter.py",
  path: "/miniwob",
  config: { actionSet: "coord", maxSteps: "20" },
  env: {},
  passEnv: [],
  createdAt: "2026-11-02T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
};
const source: BenchJob = {
  id: "original",
  spec: {
    benchmark: "miniwob",
    tasks: ["click", "type"],
    methods: [empty],
    seeds: 3,
    options: {},
    lineage: {},
  },
  revisions: {},
  resources: null,
  folder: "gui",
  metrics: [],
  source: null,
  state: "done",
  createdAt: "2026-11-02T00:00:00Z",
  endedAt: "2026-11-02T00:01:00Z",
  capabilities: caps,
  benchmarkSnapshot: registration,
};

it("imports external policy settings and CLI bundles without silently dropping them", () => {
  const methods: Method[] = [
    {
      name: "vision",
      agent: "external",
      entrypoint: "policy:make_agent",
      model: "model-v1",
      effort: "high",
      config: { temperature: "0" },
      passEnv: ["MODEL_API_KEY"],
    },
    {
      name: "coding",
      agent: "codex",
      auth: "profile",
      model: "model-v2",
      effort: "medium",
      bundle: "/methods/bundle",
    },
  ];
  expect(buildMethods(importMethods(JSON.stringify(methods)))).toEqual(methods);
});

it("rejects malformed imports and incompatible credential fields", () => {
  for (const value of [
    {},
    [],
    [null],
    [{ ...empty, agent: "unknown" }],
    [{ name: "p", agent: "external", entrypoint: "p:factory", apiKey: "not-allowed" }],
    [{ name: "p", agent: "external", entrypoint: "p:factory", auth: "cli-profile" }],
    [{ ...empty, config: {} }],
    [{ ...empty, model: "unexpected" }],
    [{ name: "p", agent: "external", entrypoint: "p:factory", config: { temperature: 0 } }],
  ])
    expect(() => importMethods(JSON.stringify(value))).toThrow();
});

it("validates capabilities, duplicate names, installed policy entrypoints and variable names", () => {
  expect(() =>
    buildMethods([methodDraft({ name: "cli", agent: "codex", auth: "profile" })], caps),
  ).toThrow("not supported");
  expect(() =>
    buildMethods([methodDraft(empty), methodDraft({ ...empty, name: " empty " })], caps),
  ).toThrow("Duplicate");
  const policy = methodDraft({ name: "p", agent: "external", entrypoint: "p:factory" });
  expect(() => buildMethods([{ ...policy, entrypoint: " " }], caps)).toThrow("entrypoint");
  expect(() => buildMethods([{ ...policy, passEnv: "MODEL_API_KEY=value" }], caps)).toThrow(
    "variable names",
  );
  expect(buildMethods([{ ...policy, passEnv: "KEY, KEY NEXT_KEY" }], caps)[0]?.passEnv).toEqual([
    "KEY",
    "NEXT_KEY",
  ]);
  expect(() =>
    buildMethods([methodDraft({ name: "cli", agent: "codex", auth: "missing" })], undefined, []),
  ).toThrow("auth profile");
});

it("does not turn an empty or unsupported task selection into all tasks", () => {
  expect(() => evaluationSpec({ ...fields, tasks: [] }, [empty], tasks)).toThrow("at least one");
  expect(() => evaluationSpec({ ...fields, tasks: ["unsupported"] }, [empty], tasks)).toThrow(
    "unsupported",
  );
  expect(() => evaluationSpec({ ...fields, tasks: ["missing"] }, [empty], tasks)).toThrow(
    "missing",
  );
});

it("preserves commas inside task IDs when copying a repeated task query", () => {
  const query = new URLSearchParams();
  query.append("task", "a,b");
  query.append("task", "other/task");
  expect(taskSubset(query)).toEqual(["a,b", "other/task"]);
  expect(taskSubset(new URLSearchParams("tasks=a,b"))).toEqual(["a", "b"]);
  expect(taskSubset(new URLSearchParams())).toBeUndefined();
  expect(taskSubset(new URLSearchParams("task="))).toEqual([]);
});

it("copies a selected task subset and preserves explicit options without mutating the source", () => {
  const before = JSON.stringify(source);
  const spec = evaluationSpec({ ...fields, tasks: ["type", "type"] }, [empty], tasks, source);
  expect(spec).toEqual({
    benchmark: "miniwob",
    tasks: ["type"],
    name: "GUI check",
    methods: [empty],
    seeds: 3,
    timeoutMin: 5,
    options: { setting: "value" },
  });
  expect(JSON.stringify(source)).toBe(before);
  expect(
    evaluationSpec({ ...fields, timeout: "", options: "{}" }, [empty], tasks).timeoutMin,
  ).toBeUndefined();
});

it.each(["0", "101", "1.5", "", "NaN"])(
  "rejects invalid repetition count %s before submission",
  (seeds) => {
    expect(() => evaluationSpec({ ...fields, seeds }, [empty], tasks)).toThrow("Repetitions");
  },
);

it("rejects non-finite budgets and non-string adapter option values", () => {
  expect(() => evaluationSpec({ ...fields, timeout: "Infinity" }, [empty], tasks)).toThrow(
    "Timeout",
  );
  expect(() => evaluationSpec({ ...fields, options: '{"value":1}' }, [empty], tasks)).toThrow(
    "string values",
  );
});

it("detects registration changes against saved conditions and treats missing history as unknown", () => {
  expect(
    registrationChanged(source, {
      ...registration,
      config: { maxSteps: "20", actionSet: "coord" },
      updatedAt: "later",
    }),
  ).toBe(false);
  expect(
    registrationChanged(source, {
      ...registration,
      config: { maxSteps: "30", actionSet: "coord" },
    }),
  ).toBe(true);
  expect(registrationChanged(source, { ...registration, adapter: "/different.py" })).toBe(true);
  expect(registrationChanged({ ...source, benchmarkSnapshot: undefined }, registration)).toBeNull();
});

describe("registered Agent methods", () => {
  it("lists registered Agents between the special kinds and checks capabilities like the daemon", async () => {
    const { capabilityAllows, isCliAgent, methodTypes } = await import(
      "../src/pages/bench/new-job.ts"
    );
    expect(methodTypes(["codex", "kimi-cli", "external"])).toEqual([
      "empty",
      "external",
      "codex",
      "kimi-cli",
      "oracle",
    ]);
    expect(isCliAgent("kimi-cli")).toBe(true);
    expect(isCliAgent("oracle")).toBe(false);
    expect(capabilityAllows(["codex"], "kimi-cli")).toBe(false);
    expect(capabilityAllows(["cli"], "kimi-cli")).toBe(true);
  });
});

it("derives only the selected trial method from a multi-method evaluation", () => {
  const first = { name: "first", agent: "codex", auth: "p" };
  const second = { name: "second", agent: "claude-code", auth: "c" };
  const basis = {
    agent: "codex",
    model: null,
    effort: null,
    authKind: null,
    cliVersion: null,
    bundleDigest: null,
    entrypoint: null,
    config: null,
  };
  const job: BenchJob = {
    ...source,
    spec: { ...source.spec, methods: [first, second, empty] },
    revisions: {
      first: { revision: "111111111111", basis, approximate: false },
      second: {
        revision: "222222222222",
        basis: { ...basis, agent: "claude-code" },
        approximate: false,
      },
    },
  };
  const before = JSON.stringify(job);
  expect(copiedMethods(job, "second", "222222222222")).toEqual([second]);
  expect(copiedMethods({ ...job, revisions: {} }, "second", "333333333333")).toEqual([second]);
  expect(copiedMethods(job, "", "111111111111")).toEqual([first]);
  expect(copiedMethods(job, "", "")).toEqual([first, second, empty]);
  expect(() => copiedMethods(job, "second", "111111111111")).toThrow("does not match");
  expect(() => copiedMethods(job, "missing", "111111111111")).toThrow(
    "single evaluated configuration",
  );
  expect(() => copiedMethods(job, "empty", "")).toThrow("single evaluated configuration");
  expect(JSON.stringify(job)).toBe(before);
  const lineage = {
    parent: "111111111111",
    note: "Fix tool recovery",
    informedBy: "original.00001",
  };
  expect(() => withLineage(job.spec, lineage)).toThrow("Select one configuration");
  expect(withLineage(job.spec, { ...lineage, method: "first" }).lineage).toEqual({
    first: { ...lineage, informedBy: ["original.00001"] },
  });
  expect(() => withLineage(job.spec, { ...lineage, method: "empty" })).toThrow(
    "Select the configuration",
  );
});
