import type {
  AgentDefinition,
  AuthProfile,
  BenchCapabilities,
  BenchCompatibility,
  BenchJob,
  Benchmark,
  BenchTask,
  Method,
  SamplePlan,
} from "@zjunlp/orbit/contracts";
import { describe, expect, it } from "vitest";
import {
  BatchSizeError,
  buildMethods,
  compatibilityCells,
  configurationBlocker,
  copiedMethods,
  type EvaluationFields,
  evaluationSpec,
  evaluationTasks,
  importMethods,
  methodDraft,
  parseSamplePlan,
  profileAllowed,
  registrationChanged,
  reviewValues,
  samplePlanTasks,
  taskResourceReview,
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
  ).toThrow(/auth profile/i);
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

describe("frozen policy evaluations", () => {
  const policy: Method = { name: "model", agent: "policy", policyRef: "pi05-libero" };
  const nativeTasks = ["put_bowl_on_plate", "close_drawer"].map(
    (id): BenchTask => ({ id, title: null, supported: true, reason: null, tags: {} }),
  );
  const plan: SamplePlan = {
    version: 1,
    digest: `sha256:${"a".repeat(64)}`,
    items: ["close_drawer", "put_bowl_on_plate", "close_drawer"].map((taskId, i) => ({
      sampleId: `sha256:${String(i).repeat(64)}`,
      taskId,
      benchmarkProfile: "libero-spatial",
      initialStateId: String(i),
      initialStateDigest: `sha256:${"b".repeat(64)}`,
      environmentSeed: 42,
      policySeed: 0,
      repetition: 0,
    })),
  };
  const nativeFields: EvaluationFields = {
    ...fields,
    benchmark: "libero-spatial",
    tasks: [],
    seeds: "",
    samplePlan: plan,
    batchSize: "2",
  };
  const calibration = { mode: "policy" as const, budgetMin: 20, rescore: false, noOracle: [] };

  it("reads an uploaded plan and lists tasks in their first sample order", () => {
    expect(parseSamplePlan(JSON.stringify(plan))).toEqual(plan);
    expect(samplePlanTasks(plan)).toEqual(["close_drawer", "put_bowl_on_plate"]);
    expect(() => parseSamplePlan("not JSON")).toThrow("valid JSON");
    for (const value of [
      { ...plan, items: [] },
      { ...plan, items: [null] },
      { ...plan, version: 2 },
    ])
      expect(() => parseSamplePlan(JSON.stringify(value))).toThrow("frozen sample plan");
  });

  it("copies the frozen sample order and batch size into a separate policy submission", () => {
    const original: BenchJob = {
      ...source,
      spec: {
        benchmark: nativeFields.benchmark,
        tasks: samplePlanTasks(plan),
        methods: [policy],
        samplePlan: plan,
        batchSize: 2,
        options: {},
        lineage: {},
      },
    };
    const before = JSON.stringify(original);
    const drafts = copiedMethods(original, "", "").map(methodDraft);
    const spec = evaluationSpec(
      {
        ...nativeFields,
        samplePlan: original.spec.samplePlan,
        batchSize: String(original.spec.batchSize),
      },
      buildMethods(drafts, { ...caps, methods: ["policy"] }),
      nativeTasks,
      original,
    );
    expect(spec).toMatchObject({
      benchmark: "libero-spatial",
      tasks: ["close_drawer", "put_bowl_on_plate"],
      methods: [policy],
      samplePlan: plan,
      batchSize: 2,
    });
    expect(spec).not.toHaveProperty("seeds");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("requires a registered policy reference and a frozen plan together", () => {
    expect(() => buildMethods([methodDraft({ ...policy, policyRef: "bad reference" })])).toThrow(
      "select a registered policy",
    );
    expect(() => evaluationSpec(nativeFields, [empty], nativeTasks)).toThrow(
      "require registered policy",
    );
    expect(() =>
      evaluationSpec(
        { ...nativeFields, samplePlan: undefined, tasks: ["close_drawer"] },
        [policy],
        nativeTasks,
      ),
    ).toThrow("Upload a frozen sample plan");
    expect(() => evaluationSpec(nativeFields, [policy], nativeTasks.slice(0, 1))).toThrow(
      "missing or unsupported",
    );
  });

  it("lets task selection proceed before validating the batch size on submission", () => {
    const draft = { ...nativeFields, batchSize: "1", maxBatchSize: 128 };
    expect(evaluationTasks(draft, nativeTasks)).toEqual(["close_drawer", "put_bowl_on_plate"]);
    expect(() => evaluationSpec(draft, [policy], nativeTasks)).toThrow(BatchSizeError);
    expect(() => evaluationSpec({ ...draft, batchSize: "129" }, [policy], nativeTasks)).toThrow(
      "from 2 to 128",
    );
    expect(evaluationSpec({ ...draft, batchSize: "" }, [policy], nativeTasks)).not.toHaveProperty(
      "batchSize",
    );
  });

  it("keeps the copied calibration settings and derives its batch size from the plan", () => {
    const spec = evaluationSpec(
      { ...nativeFields, calibration, timeout: "25" },
      [policy],
      nativeTasks,
    );
    expect(spec).toMatchObject({
      calibration,
      timeoutMin: 20,
      samplePlan: plan,
      batchSize: 3,
    });
    expect(
      evaluationSpec({ ...nativeFields, calibration, timeout: "5" }, [policy], nativeTasks)
        .timeoutMin,
    ).toBe(5);
    expect(
      evaluationSpec({ ...nativeFields, calibration, timeout: "" }, [policy], nativeTasks)
        .timeoutMin,
    ).toBe(20);
  });

  it("requires 2–5 planned samples and one model when copying a policy calibration", () => {
    const fields = { ...nativeFields, calibration };
    expect(() =>
      evaluationSpec(fields, [policy, { ...policy, name: "second" }], nativeTasks),
    ).toThrow("exactly one registered policy");
    expect(() =>
      evaluationSpec(
        { ...fields, samplePlan: { ...plan, items: plan.items.slice(0, 1) } },
        [policy],
        nativeTasks,
      ),
    ).toThrow("2–5 samples");
    expect(() =>
      evaluationSpec({ ...fields, samplePlan: undefined }, [policy], nativeTasks),
    ).toThrow("needs a frozen sample plan");
  });
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

it("reviews only selected task overrides and prefers the previous review when present", () => {
  const tasks = ["click", "type", "scroll"].map(
    (id): BenchTask => ({ id, title: id, supported: true, reason: null, tags: {} }),
  );
  const original = {
    tasks: source.spec.tasks,
    resources: { click: { cpus: 4, memGB: 8 }, type: { cpus: 4 } },
  };
  const current = {
    tasks,
    resourceOverrides: { click: { memGB: 8, cpus: 12 }, type: { cpus: 16 }, scroll: { cpus: 16 } },
  };
  const refreshed = { tasks: ["click"], resources: { click: { cpus: 8, memGB: 8 } } };
  expect(taskResourceReview(current, ["click", "scroll"], [refreshed, original])).toEqual([
    {
      task: "click",
      values: [
        { label: "CPU", value: "12 cores", previous: "8 cores" },
        { label: "Memory", value: "8 GB", previous: undefined },
      ],
    },
    { task: "scroll", values: [{ label: "CPU", value: "16 cores", previous: undefined }] },
  ]);
  expect(taskResourceReview({ tasks }, ["click"], [original])[0]?.values).toContainEqual({
    label: "CPU",
    value: "no override",
    previous: "4 cores",
  });
  expect(
    taskResourceReview(current, ["click"], [{ tasks: source.spec.tasks }])[0]?.values,
  ).toContainEqual({
    label: "CPU",
    value: "12 cores",
    previous: "no override",
  });
});

it("falls back to the copied value when a refresh did not change the field", () => {
  expect(
    reviewValues({ CPU: "8 cores" }, [{ CPU: "8 cores" }, { CPU: "4 cores" }], "none"),
  ).toEqual([{ label: "CPU", value: "8 cores", previous: "4 cores" }]);
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

const cliDefinition = { name: "custom", auth: { kinds: ["api-key"] } } as AgentDefinition;
const cliProfile = { name: "key", harness: "custom", kind: "api-key" } as AuthProfile;
const cliDraft = methodDraft({ name: "agent", agent: "custom", auth: "key" });

it("only accepts compatibility cells marked fresh for the exact benchmark", () => {
  const result: BenchCompatibility = {
    agents: ["custom"],
    rows: [
      {
        benchmark: "one",
        cells: { custom: { state: "blocked", reason: "MCP is not wired", valid: 5 } },
      },
    ],
  };
  expect(compatibilityCells("one", result)).toBeUndefined();
  result.checked = { benchmark: "two", at: "2026-11-26T00:00:00Z" };
  expect(compatibilityCells("one", result)).toBeUndefined();
  result.checked.benchmark = "one";
  expect(compatibilityCells("one", result)?.custom?.state).toBe("blocked");
  expect(compatibilityCells("two", result)).toBeUndefined();
});

it("blocks fresh declared incompatibility despite historical valid trials", () => {
  const cells = {
    custom: { state: "blocked" as const, reason: "MCP is not wired", valid: 5, trials: 6 },
  };
  expect(configurationBlocker(cliDraft, [cliProfile], [cliDefinition], cells.custom)).toContain(
    "MCP",
  );
  expect(() => buildMethods([cliDraft], undefined, [cliProfile], [cliDefinition], cells)).toThrow(
    "MCP",
  );
});

it("checks the selected credential kind and known Agent registry, not just the existence of some profile", () => {
  const wrong = { ...cliProfile, kind: "login" } as AuthProfile;
  expect(profileAllowed(wrong, "custom", cliDefinition)).toBe(false);
  expect(configurationBlocker(cliDraft, [wrong], [cliDefinition], { state: "allowed" })).toContain(
    "does not accept",
  );
  expect(() => buildMethods([cliDraft], undefined, [wrong], [cliDefinition])).toThrow(
    "does not accept",
  );
  expect(configurationBlocker(cliDraft, [cliProfile], [])).toContain("not registered");
  expect(configurationBlocker(cliDraft, [cliProfile], undefined)).toBeNull();
  expect(configurationBlocker(cliDraft, undefined, [cliDefinition])).toBeNull();
});

it("does not block valid selected profiles on unknown or needs-auth aggregate states", () => {
  for (const state of ["unknown", "needs-auth", "allowed", "ran"] as const) {
    expect(
      buildMethods([cliDraft], undefined, [cliProfile], [cliDefinition], { custom: { state } })[0]
        ?.agent,
    ).toBe("custom");
  }
});

it("keeps controls and policies outside CLI compatibility", () => {
  const blocked = { state: "blocked" as const, reason: "CLI only" };
  for (const agent of ["empty", "oracle", "external", "policy"] as const) {
    const draft = methodDraft({
      name: agent,
      agent,
      ...(agent === "external" ? { entrypoint: "fixture:policy" } : {}),
      ...(agent === "policy" ? { policyRef: "registered-policy" } : {}),
    });
    expect(configurationBlocker(draft, [], [], blocked)).toBeNull();
    expect(buildMethods([draft], undefined, [], [], { [agent]: blocked })[0]?.agent).toBe(agent);
  }
});
