import type {
  AgentDefinition,
  AgentInfo,
  AuthProfile,
  BenchCapabilities,
  BenchJob,
  Benchmark,
  BenchTaskList,
  Method,
  PolicyDefinition,
  SamplePlan,
} from "@zjunlp/orbit/contracts";
import { useMemo, useRef, useState } from "react";
import { TopBar } from "../../components/TopBar.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { jobPath } from "../../lib/format.ts";
import { navigate, useLocation } from "../../lib/router.ts";
import { type Async, useAsync } from "../../lib/use.ts";
import { CompatibilityRefresh, CompatibilityStatus } from "./CompatibilityStatus.tsx";
import { jobLabel } from "./common.tsx";
import {
  BatchSizeError,
  buildMethods,
  capabilityAllows,
  compatibilityCells,
  configurationBlocker,
  copiedMethods,
  evaluationSpec,
  evaluationTasks,
  evaluationTimeoutMin,
  importMethods,
  isCliAgent,
  METHOD_TYPES,
  type MethodDraft,
  methodDraft,
  methodTypes,
  parseSamplePlan,
  policyRegistrationChanged,
  policyResourceValues,
  profileAllowed,
  type ReviewValue,
  registrationChanged,
  reviewValues,
  samplePlanTasks,
  taskResourceReview,
  taskSubset,
  withLineage,
} from "./new-job.ts";
import "./launch.css";

const TYPE_LABEL: Record<string, string> = {
  empty: "Empty baseline",
  external: "External policy",
  codex: "Codex",
  "claude-code": "Claude Code",
  oracle: "Oracle baseline",
  policy: "Registered policy",
};
const typeLabel = (agent: string) => TYPE_LABEL[agent] ?? agent;
const STEPS = ["Environment & tasks", "Configurations", "Review & start"];
type ReviewedPolicy = { definition: PolicyDefinition; digest: string };

export function NewBenchJob() {
  const loc = useLocation();
  const from = loc.query.get("from") ?? "";
  const source = useAsync(() => (from ? api.benchJob(from) : Promise.resolve(null)), [from]);
  const benchmarks = useAsync(() => api.benchmarks(), []);
  const jobs = useAsync(() => api.benchJobs(), []);
  const profiles = useAsync(() => api.authProfiles(), []);
  const agents = useAsync(() => api.agents(), []);
  const preset = loc.query.get("benchmark") ?? "";
  const subset = taskSubset(loc.query);
  // Reuse a trial configuration while retaining its source version and supporting trials.
  const derive = {
    parent: loc.query.get("parent") ?? "",
    method: loc.query.get("method") ?? "",
    informedBy: (loc.query.get("informedBy") ?? "").split(",").filter(Boolean),
  };
  const loadedSource = source.data?.job.id === from ? source.data.job : undefined;

  return (
    <>
      <TopBar crumbs={[{ label: "Evaluations", href: "/bench" }, { label: "New evaluation" }]} />
      <div className="page">
        <div className="page-pad bench-launch">
          {benchmarks.error ? (
            <div className="callout" role="alert">
              {benchmarks.error}
            </div>
          ) : !benchmarks.data ? (
            <Loading what="Loading registered environments" />
          ) : from && source.error ? (
            <Empty title="Could not copy this evaluation">
              {source.error}
              <p>
                <Link href="/bench/new">Create a new evaluation</Link>
              </p>
            </Empty>
          ) : from && !loadedSource ? (
            <Loading what="Loading evaluation configuration" />
          ) : !benchmarks.data.length ? (
            <Empty title="No registered environments">
              <p>Prepare an environment and register its adapter first:</p>
              <p>
                <code>orbit bench add mine /path/to/benchmark --adapter /path/to/adapter.py</code>
              </p>
            </Empty>
          ) : (
            <NewJobForm
              key={JSON.stringify([from, preset, subset, derive])}
              derive={derive}
              benchmarks={benchmarks.data}
              source={loadedSource}
              preset={preset}
              subset={subset}
              jobs={jobs.data ?? []}
              profiles={profiles.loading || profiles.error ? undefined : profiles.data}
              definitions={
                agents.loading || agents.error ? undefined : agents.data?.map((a) => a.definition)
              }
              registryNotice={
                agents.error
                  ? `Agent registry unavailable: ${agents.error}`
                  : agents.loading
                    ? "Agent definitions are loading."
                    : profiles.error
                      ? `Credential profiles unavailable: ${profiles.error}`
                      : profiles.loading
                        ? "Credential profiles are loading."
                        : undefined
              }
              checksLoading={agents.loading || profiles.loading}
              onRefresh={() => {
                agents.reload();
                profiles.reload();
              }}
              agents={agents}
              profilesError={profiles.error}
            />
          )}
        </div>
      </div>
    </>
  );
}

function NewJobForm({
  benchmarks,
  source,
  preset,
  subset,
  jobs,
  profiles,
  profilesError,
  definitions,
  registryNotice,
  checksLoading,
  onRefresh,
  agents,
  derive,
}: {
  derive: { parent: string; method: string; informedBy: string[] };
  benchmarks: Benchmark[];
  source?: BenchJob;
  preset: string;
  subset?: string[];
  jobs: BenchJob[];
  profiles?: AuthProfile[];
  profilesError: string | null;
  definitions?: AgentDefinition[];
  registryNotice?: string;
  checksLoading: boolean;
  onRefresh: () => void;
  agents: Async<AgentInfo[]>;
}) {
  const calibration =
    !derive.method &&
    !derive.parent &&
    !derive.informedBy.length &&
    source?.spec.calibration?.mode === "policy"
      ? source.spec.calibration
      : undefined;
  const [stage, setStage] = useState(0);
  const [benchmark, setBenchmark] = useState(source?.spec.benchmark ?? preset);
  const [chosen, setChosen] = useState<string[] | null>(subset ?? source?.spec.tasks ?? null);
  const [search, setSearch] = useState("");
  const [legacyDrafts, setLegacyDrafts] = useState(() =>
    source && !source.spec.samplePlan
      ? copiedMethods(source, derive.method, derive.parent).map(methodDraft)
      : [methodDraft({ name: "empty", agent: "empty" })],
  );
  const [policyDrafts, setPolicyDrafts] = useState(() =>
    source?.spec.samplePlan
      ? copiedMethods(source, derive.method, derive.parent).map(methodDraft)
      : [methodDraft({ name: "model", agent: "policy" })],
  );
  const [lineageTarget, setLineageTarget] = useState("");
  const [name, setName] = useState(source ? `${jobLabel(source)} copy`.slice(0, 200) : "");
  const [seeds, setSeeds] = useState(String(source?.spec.seeds ?? 1));
  const [samplePlan, setSamplePlan] = useState<SamplePlan | undefined>(source?.spec.samplePlan);
  const [planFile, setPlanFile] = useState("");
  const [batchSize, setBatchSize] = useState(String(source?.spec.batchSize ?? ""));
  const [batchSizeError, setBatchSizeError] = useState<string | null>(null);
  const [readingPlan, setReadingPlan] = useState(false);
  const planRead = useRef(0);
  const [timeout, setTimeout] = useState(
    source?.spec.timeoutMin === undefined ? "" : String(source.spec.timeoutMin),
  );
  const [folder, setFolder] = useState(source?.folder ?? "");
  const [options, setOptions] = useState(JSON.stringify(source?.spec.options ?? {}, null, 2));
  const [importText, setImportText] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [parent, setParent] = useState(derive.parent);
  const [note, setNote] = useState("");
  const [informedBy, setInformedBy] = useState(derive.informedBy.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reviewedPolicies, setReviewedPolicies] = useState<Map<string, ReviewedPolicy> | null>(
    null,
  );
  const [policyBaselines, setPolicyBaselines] = useState(() => new Map<string, ReviewedPolicy>());
  const [environmentBaseline, setEnvironmentBaseline] = useState<BenchTaskList | null>(null);
  const info = useAsync(async () => {
    if (!benchmark) return null;
    const value = await api.benchInfo(benchmark);
    if (value.resourceError) throw new Error(value.resourceError);
    return { benchmark, value };
  }, [benchmark]);
  const compatibility = useAsync(
    async (signal) =>
      benchmark ? { benchmark, value: await api.benchCompatibility(benchmark, signal) } : null,
    [benchmark],
    { resetKey: benchmark },
  );
  const cells = compatibilityCells(
    benchmark,
    !compatibility.loading && !compatibility.error && compatibility.data?.benchmark === benchmark
      ? compatibility.data.value
      : undefined,
  );
  const current = info.data?.benchmark === benchmark ? info.data.value : undefined;
  const registered = benchmarks.find((b) => b.name === benchmark);
  const reviewedRegistration = current?.registration ?? registered;
  const tasks = current?.tasks ?? [];
  const capabilities = current?.capabilities;
  const planned = Boolean(capabilities?.embodied);
  const batch = capabilities?.embodied?.batch;
  const calibrationBudget = calibration?.budgetMin;
  const timeoutMin = evaluationTimeoutMin(timeout, calibrationBudget);
  const timeoutHelp =
    calibrationBudget !== undefined
      ? "Leave blank to use the total calibration budget as the sample timeout. Higher values are capped at that budget."
      : batch && Number(batchSize) >= 2
        ? "A shared Solve Run’s timeout is the sum of its sample timeouts."
        : null;
  const configuringPolicies = planned && stage === 1;
  const policies = useAsync(
    (signal) => (configuringPolicies ? api.policies(signal) : Promise.resolve(null)),
    [],
    { resetKey: configuringPolicies },
  );
  const availablePolicies = calibration
    ? policies.data?.policies.filter((policy) => policy.kind === "model")
    : policies.data?.policies;
  const drafts = planned ? policyDrafts : legacyDrafts;
  const setDrafts = planned ? setPolicyDrafts : setLegacyDrafts;
  const lineageMethods = drafts.filter((m) => m.agent !== "oracle" && m.agent !== "empty");
  const lineageMethod = lineageMethods.find((m) => m.id === lineageTarget) ?? lineageMethods[0];
  const planTasks = useMemo(() => (samplePlan ? samplePlanTasks(samplePlan) : []), [samplePlan]);
  const supported = tasks.filter((t) => t.supported);
  const selected = planned ? planTasks : (chosen ?? supported.map((t) => t.id));
  const visibleTasks = tasks.filter((t) =>
    `${t.id} ${t.title ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const changed =
    source && reviewedRegistration ? registrationChanged(source, reviewedRegistration) : false;
  const original = source?.spec.benchmark === benchmark ? source : undefined;
  const taskResources =
    planned && current
      ? taskResourceReview(current, selected, [
          ...(original?.benchmarkSnapshot
            ? [{ tasks: original.spec.tasks, resources: original.resources }]
            : []),
          ...(environmentBaseline
            ? [
                {
                  tasks: environmentBaseline.tasks.map(({ id }) => id),
                  resources: environmentBaseline.resourceOverrides,
                },
              ]
            : []),
        ])
      : [];
  const resourcesChanged = taskResources.some(({ values }) =>
    values.some(({ previous }) => previous !== undefined),
  );
  const conditions = capabilities?.conditions ?? {};
  const originalConditions = planned ? original?.capabilities?.conditions : undefined;
  const draftConditions = environmentBaseline?.capabilities?.conditions;
  const environmentRows = reviewValues(
    conditions,
    originalConditions ? { ...draftConditions, ...originalConditions } : draftConditions,
    "not recorded",
  );
  const sampleCount = samplePlan?.items.length ?? 0;
  const repetitions = Number.isInteger(Number(seeds)) && Number(seeds) > 0 ? Number(seeds) : 0;
  const count = (planned ? sampleCount : selected.length * repetitions) * drafts.length;
  const fields = {
    benchmark,
    tasks: selected,
    name,
    seeds,
    timeout,
    options,
    calibration,
    ...(planned ? { samplePlan, batchSize, maxBatchSize: batch?.maxEpisodes } : {}),
  };
  const types: Method["agent"][] = planned
    ? ["policy"]
    : definitions
      ? methodTypes(definitions.map((definition) => definition.name))
      : METHOD_TYPES;
  const methodAllowed = capabilities
    ? types.filter((a) => capabilityAllows(capabilities.methods, a))
    : types;
  const copyReady = definitions !== undefined;
  const copySources =
    stage === 1 && !planned && copyReady
      ? jobs.flatMap((job) => {
          const methods: Method[] = [];
          const skipped: Method[] = [];
          for (const method of job.spec.methods) {
            (methodAllowed.includes(method.agent) ? methods : skipped).push(method);
          }
          return methods.length ? [{ job, methods, skipped }] : [];
        })
      : [];
  const updateMethod = (index: number, patch: Partial<MethodDraft>) =>
    setDrafts((all) => all.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const blocked = drafts.some((draft) =>
    configurationBlocker(draft, profiles, definitions, cells?.[draft.agent]),
  );
  const refreshChecks = () => {
    info.reload();
    compatibility.reload();
    onRefresh();
  };
  const refreshing = compatibility.loading || info.loading || checksLoading;
  const status = (draft: MethodDraft) =>
    planned ? null : (
      <CompatibilityStatus
        draft={draft}
        cell={cells?.[draft.agent]}
        loading={compatibility.loading}
        error={compatibility.error}
        blocker={configurationBlocker(draft, profiles, definitions, cells?.[draft.agent])}
        registryNotice={registryNotice}
      />
    );
  const selectBenchmark = (name: string) => {
    planRead.current++;
    setReadingPlan(false);
    setBenchmark(name);
    setEnvironmentBaseline(null);
    setReviewedPolicies(null);
    setPolicyBaselines(new Map());
    setChosen(null);
    setSearch("");
    setError(null);
    setCopyNotice("");
    setPlanFile("");
    setSamplePlan(source?.spec.benchmark === name ? source.spec.samplePlan : undefined);
    setBatchSize(String(source?.spec.benchmark === name ? (source.spec.batchSize ?? "") : ""));
    setBatchSizeError(null);
  };

  const importPlan = async (file: File) => {
    const request = ++planRead.current;
    setReadingPlan(true);
    setSamplePlan(undefined);
    setPlanFile("");
    setError(null);
    try {
      const plan = parseSamplePlan(await file.text());
      if (request !== planRead.current) return;
      setSamplePlan(plan);
      setPlanFile(file.name);
    } catch (e) {
      if (request === planRead.current) setError((e as Error).message);
    } finally {
      if (request === planRead.current) setReadingPlan(false);
    }
  };

  const reviewPolicies = (methods: Method[]) => {
    if (!availablePolicies || policies.loading || policies.error)
      throw new Error("Load the registered policies before continuing.");
    const digests = policies.data?.policyDigests;
    return new Map(
      methods.map((method) => {
        const policy = availablePolicies.find((policy) => policy.name === method.policyRef);
        if (!policy) throw new Error(`${method.name}: select an available policy.`);
        const digest = digests && Object.hasOwn(digests, policy.name) ? digests[policy.name] : null;
        if (!digest)
          throw new Error(`${method.name}: policy digest is unavailable. Refresh policies.`);
        return [method.name, { definition: policy, digest }];
      }),
    );
  };

  const refreshPolicies = () => {
    setError(null);
    if (configuringPolicies) policies.reload();
    else setStage(1);
  };

  const next = () => {
    try {
      if (!registered || !current || info.loading || info.error)
        throw new Error("Load a registered environment before continuing.");
      if (samplePlan && !planned)
        throw new Error("The selected environment does not support frozen sample plans.");
      if (stage === 0) {
        if (planned) {
          if (!samplePlan) throw new Error("Choose a frozen sample plan.");
          evaluationTasks(fields, tasks);
        } else {
          evaluationSpec(fields, [{ name: "preview", agent: "empty" }], tasks, source);
        }
      } else {
        const methods = buildMethods(drafts, capabilities, profiles, definitions, cells);
        const updated = planned ? reviewPolicies(methods) : null;
        if (updated) {
          setEnvironmentBaseline((baseline) => baseline ?? current);
          setPolicyBaselines((baselines) => {
            const firstReviews = new Map(baselines);
            for (const policy of updated.values()) {
              const name = policy.definition.name;
              if (!firstReviews.has(name)) firstReviews.set(name, policy);
            }
            return firstReviews;
          });
        }
        setReviewedPolicies(updated);
      }
      setError(null);
      setStage((s) => s + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = async () => {
    if (submitting) return;
    try {
      if (!registered || !current || info.loading || info.error)
        throw new Error("Reload the environment before starting.");
      if (samplePlan && !planned)
        throw new Error("The selected environment does not support frozen sample plans.");
      if (planned && !samplePlan) throw new Error("Choose a frozen sample plan.");
      if (planned && !reviewedPolicies)
        throw new Error("Review the selected policies before starting.");
      const expectedBenchmarkDigest = planned ? current.benchmarkDigest : undefined;
      if (planned && !expectedBenchmarkDigest)
        throw new Error(
          "Environment digest is unavailable. Refresh the environment before starting.",
        );
      const methods = buildMethods(drafts, capabilities, profiles, definitions, cells);
      const spec = withLineage(evaluationSpec(fields, methods, tasks, source), {
        parent,
        note,
        informedBy,
        method: lineageMethod?.name.trim(),
      });
      setError(null);
      setSubmitting(true);
      const expectedPolicyDigests = reviewedPolicies
        ? Object.fromEntries(
            Array.from(reviewedPolicies, ([name, policy]) => [name, policy.digest]),
          )
        : undefined;
      const job = await api.benchSubmit(
        { ...spec, expectedPolicyDigests, expectedBenchmarkDigest },
        folder.trim(),
      );
      navigate(jobPath(job.id));
    } catch (e) {
      if (e instanceof BatchSizeError) {
        setError(null);
        setBatchSizeError(e.message);
      } else {
        setError((e as Error).message);
      }
      setSubmitting(false);
    }
  };
  const importFromText = () => {
    try {
      setDrafts(importMethods(importText));
      setError(null);
      setImportText("");
      setCopyNotice("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <nav className="bench-launch-steps" aria-label="Evaluation setup steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            className={`btn${stage === i ? " on" : " ghost"}`}
            aria-current={stage === i ? "step" : undefined}
            disabled={i > stage || submitting}
            onClick={() => {
              setStage(i);
              setError(null);
            }}
          >
            {i + 1}. {label}
          </button>
        ))}
      </nav>
      {source && (
        <div className="muted">
          Copying <Link href={jobPath(source.id)}>{jobLabel(source)}</Link>. This starts a new{" "}
          {calibration ? "policy calibration" : "evaluation"} using the selected registration.
        </div>
      )}
      {source && changed !== false && (
        <div className="callout">
          {changed === null
            ? "The original environment configuration was not recorded. Review the current preset before starting."
            : "The registered environment differs from the saved configuration. This evaluation will use the current preset shown below."}
        </div>
      )}
      {resourcesChanged && (
        <div className="callout">
          Registered resource overrides changed for selected tasks. Review the differences before
          starting.
        </div>
      )}
      {stage > 0 && info.error && (
        <div className="callout" role="alert">
          Could not reload environment tasks: {info.error}. Use{" "}
          {planned ? "Refresh environment" : "Refresh configuration checks"} to reload tasks before
          continuing or starting. Your draft configurations are kept.
        </div>
      )}
      <div className="bench-launch-grid">
        <div className="col" style={{ gap: 16 }}>
          {stage === 0 && (
            <section className="card">
              <div className="card-h">Environment & tasks</div>
              <div className="card-b col" style={{ gap: 16 }}>
                <label className="bench-field">
                  Registered environment
                  <select
                    className="input"
                    value={benchmark}
                    onChange={(e) => selectBenchmark(e.target.value)}
                  >
                    <option value="">Select an environment</option>
                    {benchmark && !registered && (
                      <option value={benchmark} disabled>
                        {benchmark} (not registered)
                      </option>
                    )}
                    {benchmarks.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                {registered && (
                  <p className="muted">
                    Registered on this daemon. Listing tasks does not check browser startup or model
                    connectivity.
                  </p>
                )}
                {benchmark && info.loading && (
                  <Loading what="Listing tasks and supported configuration types" />
                )}
                {info.error && (
                  <div className="callout" role="alert">
                    {info.error}{" "}
                    <button className="btn sm" type="button" onClick={info.reload}>
                      Retry
                    </button>
                  </div>
                )}
                {current && !info.loading && !info.error && (
                  <>
                    <PresetConditions capabilities={capabilities} />
                    {planned ? (
                      <>
                        <label className="bench-field">
                          Frozen sample plan
                          <input
                            key={benchmark}
                            className="input"
                            type="file"
                            accept=".json,application/json"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void importPlan(file);
                            }}
                          />
                        </label>
                        {readingPlan ? (
                          <Loading what="Reading sample plan" />
                        ) : samplePlan ? (
                          <p className="muted">
                            {planFile || "Copied sample plan"} · {sampleCount} samples across{" "}
                            {planTasks.length} tasks
                          </p>
                        ) : (
                          <p className="muted">
                            Upload the JSON plan generated for this benchmark before choosing
                            models.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="row bench-wrap">
                          <label className="bench-field grow">
                            Find tasks
                            <input
                              className="input"
                              type="search"
                              value={search}
                              onChange={(e) => setSearch(e.target.value)}
                              placeholder="Task ID or title"
                            />
                          </label>
                          <button
                            className="btn sm"
                            type="button"
                            onClick={() => setChosen(supported.map((t) => t.id))}
                          >
                            Select all supported
                          </button>
                          <button
                            className="btn sm ghost"
                            type="button"
                            onClick={() => setChosen([])}
                          >
                            Clear
                          </button>
                        </div>
                        <p className="muted">
                          {selected.length} selected · {supported.length} supported / {tasks.length}{" "}
                          listed
                        </p>
                        <div className="bench-task-picker">
                          {visibleTasks.map((t) => (
                            <label
                              className={`bench-task-choice${t.supported ? "" : " muted"}`}
                              key={t.id}
                            >
                              <input
                                type="checkbox"
                                className="check"
                                disabled={!t.supported}
                                checked={selected.includes(t.id)}
                                onChange={() =>
                                  setChosen(
                                    selected.includes(t.id)
                                      ? selected.filter((id) => id !== t.id)
                                      : [...selected, t.id],
                                  )
                                }
                              />
                              <span>
                                <span className="mono">{t.id}</span>
                                {t.title && <span className="muted"> · {t.title}</span>}
                                {!t.supported && (
                                  <span className="bench-task-reason">
                                    Unsupported: {t.reason ?? "Not supported by this adapter"}
                                  </span>
                                )}
                              </span>
                            </label>
                          ))}
                          {!visibleTasks.length && <p className="muted">No matching tasks.</p>}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
          {stage === 1 && (
            <>
              {planned ? (
                <>
                  {policies.loading && <Loading what="Loading registered policies" />}
                  {policies.error && (
                    <div className="callout" role="alert">
                      {policies.error}{" "}
                      <button className="btn sm" type="button" onClick={policies.reload}>
                        Retry
                      </button>
                    </div>
                  )}
                  {!policies.loading && !policies.error && availablePolicies?.length === 0 && (
                    <div className="callout">
                      Register a model first with <code>orbit policy add policy.json</code>.
                    </div>
                  )}
                </>
              ) : (
                <section className="card">
                  <div className="card-h">Evaluation configurations</div>
                  <div className="card-b col" style={{ gap: 12 }}>
                    <p className="muted">
                      Use an installed policy or a configured CLI agent. External policies must
                      already be available in the environment.
                    </p>
                    <label className="bench-field">
                      Copy configurations from an evaluation
                      <select
                        className="input"
                        value=""
                        disabled={!copyReady}
                        onChange={(e) => {
                          const selection = copySources.find(
                            ({ job }) => job.id === e.target.value,
                          );
                          if (!selection) return;
                          const skipped = selection.skipped
                            .map((method) => `${method.name} (${typeLabel(method.agent)})`)
                            .join(", ");
                          setDrafts(selection.methods.map(methodDraft));
                          setError(null);
                          setCopyNotice(
                            skipped
                              ? `Skipped ${skipped}. These configuration types are unavailable in this environment.`
                              : "",
                          );
                        }}
                      >
                        <option value="">Choose an evaluation…</option>
                        {copySources.map(({ job, methods, skipped }) => (
                          <option key={job.id} value={job.id}>
                            {jobLabel(job)} · {job.spec.benchmark}
                            {skipped.length
                              ? ` · ${methods.length}/${job.spec.methods.length} configurations can be copied`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {agents.loading ? (
                      <p className="muted" role="status">
                        Loading registered Agents…
                      </p>
                    ) : (
                      agents.error && (
                        <div className="callout" role="alert">
                          Could not load the Agent list. {agents.error}{" "}
                          <button className="btn sm" type="button" onClick={agents.reload}>
                            Retry
                          </button>
                        </div>
                      )
                    )}
                    {copyNotice && (
                      <div className="callout" role="status">
                        {copyNotice}
                      </div>
                    )}
                    <details>
                      <summary>Import configurations</summary>
                      <div className="col" style={{ gap: 8, marginTop: 8 }}>
                        <label className="bench-field">
                          Configurations JSON
                          <textarea
                            className="input mono"
                            rows={5}
                            value={importText}
                            onChange={(e) => setImportText(e.target.value)}
                            placeholder={
                              '[{"name":"vision","agent":"external","entrypoint":"my_policy:make_agent"}]'
                            }
                          />
                        </label>
                        <p className="muted">
                          Import non-secret settings only. API keys belong in the daemon
                          environment, referenced by variable name.
                        </p>
                        <button
                          className="btn sm"
                          type="button"
                          disabled={!importText.trim()}
                          onClick={importFromText}
                        >
                          Import configurations
                        </button>
                      </div>
                    </details>
                    <CompatibilityRefresh loading={refreshing} onRefresh={refreshChecks} />
                    {profilesError && drafts.some((d) => isCliAgent(d.agent)) && (
                      <div className="callout">Could not load auth profiles: {profilesError}</div>
                    )}
                  </div>
                </section>
              )}
              {drafts.map((draft, i) => (
                <MethodEditor
                  key={draft.id}
                  draft={draft}
                  index={i}
                  allowed={methodAllowed}
                  unavailableType={
                    capabilities && !capabilityAllows(capabilities.methods, draft.agent)
                      ? "unsupported"
                      : definitions
                        ? "not registered"
                        : "not verified"
                  }
                  profiles={profiles}
                  definition={definitions?.find((definition) => definition.name === draft.agent)}
                  status={status(draft)}
                  policies={planned ? availablePolicies : undefined}
                  originalPolicy={
                    source?.spec.methods.find((method) => method.policyRef === draft.policyRef)
                      ?.policySnapshot
                  }
                  onChange={(patch) => updateMethod(i, patch)}
                  onRemove={
                    calibration
                      ? undefined
                      : () => setDrafts((all) => all.filter((_, j) => j !== i))
                  }
                />
              ))}
              {!calibration && (
                <div>
                  <button
                    className="btn"
                    type="button"
                    disabled={!methodAllowed.length}
                    onClick={() => {
                      const agent = planned
                        ? "policy"
                        : methodAllowed.includes("external")
                          ? "external"
                          : (methodAllowed[0] ?? "empty");
                      setDrafts([
                        ...drafts,
                        methodDraft({ name: `configuration-${drafts.length + 1}`, agent }),
                      ]);
                    }}
                  >
                    Add configuration
                  </button>
                </div>
              )}
            </>
          )}
          {stage === 2 && (
            <section className="card">
              <div className="card-h">
                {calibration ? "Review policy calibration" : "Review & start"}
              </div>
              <div className="card-b col" style={{ gap: 16 }}>
                {calibration && (
                  <dl className="kv">
                    <dt>Total calibration budget</dt>
                    <dd>{calibration.budgetMin} min from submission, including queue time</dd>
                    <dt>Automatic rescore</dt>
                    <dd>{calibration.rescore ? "Enabled" : "Disabled"}</dd>
                    <dt>Solve batch size</dt>
                    <dd>{sampleCount}</dd>
                  </dl>
                )}
                <fieldset className="bench-lineage">
                  <legend>Configuration notes (optional)</legend>
                  <p className="faint">
                    Record the source version and supporting trials for one configuration. Changing
                    the model, reasoning effort or optional files creates a new version; leave the
                    source version empty to repeat the same configuration.
                  </p>
                  <label className="bench-field">
                    Configuration
                    <select
                      className="input"
                      value={lineageMethod?.id ?? ""}
                      onChange={(e) => setLineageTarget(e.target.value)}
                      disabled={!lineageMethods.length}
                    >
                      {!lineageMethods.length && (
                        <option value="">Add an Agent or policy configuration first</option>
                      )}
                      {lineageMethods.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || "Unnamed configuration"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="bench-field">
                    Based on version
                    <input
                      className="input mono"
                      value={parent}
                      placeholder="12 hex digits, from Evaluation configurations"
                      onChange={(e) => setParent(e.target.value.trim())}
                    />
                  </label>
                  <label className="bench-field">
                    What changed
                    <textarea
                      className="input"
                      rows={2}
                      value={note}
                      placeholder="e.g. change reasoning effort from high to xhigh"
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                  <label className="bench-field">
                    Supporting trials
                    <input
                      className="input mono"
                      value={informedBy}
                      placeholder="job.00003, …"
                      onChange={(e) => setInformedBy(e.target.value)}
                    />
                  </label>
                </fieldset>
                <label className="bench-field">
                  Evaluation name
                  <input
                    className="input"
                    value={name}
                    maxLength={200}
                    placeholder="Optional name"
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div className="bench-field-grid">
                  {planned ? (
                    !calibration &&
                    (batch || batchSize) && (
                      <div className="bench-field">
                        <label htmlFor="solve-batch-size">Solve batch size</label>
                        <input
                          id="solve-batch-size"
                          className="input"
                          type="number"
                          min="2"
                          max={batch?.maxEpisodes ?? 256}
                          step="1"
                          value={batchSize}
                          placeholder="One sample per solve"
                          aria-invalid={batchSizeError ? true : undefined}
                          aria-describedby={batchSizeError ? "solve-batch-size-error" : undefined}
                          onChange={(e) => {
                            setBatchSize(e.target.value);
                            setBatchSizeError(null);
                          }}
                        />
                        {batchSizeError && (
                          <div className="callout" id="solve-batch-size-error" role="alert">
                            {batchSizeError}
                          </div>
                        )}
                      </div>
                    )
                  ) : (
                    <label className="bench-field">
                      Repetitions per task and configuration
                      <input
                        className="input"
                        type="number"
                        min="1"
                        max="100"
                        step="1"
                        value={seeds}
                        onChange={(e) => setSeeds(e.target.value)}
                      />
                    </label>
                  )}
                  <div className="bench-field">
                    <label htmlFor="evaluation-timeout">
                      {planned ? "Sample timeout (minutes)" : "Solve timeout (minutes)"}
                    </label>
                    <input
                      id="evaluation-timeout"
                      className="input"
                      type="number"
                      min="0"
                      max={calibrationBudget}
                      step="any"
                      value={timeout}
                      placeholder={
                        calibrationBudget === undefined
                          ? "Environment preset"
                          : "Calibration budget"
                      }
                      aria-describedby={timeoutHelp ? "evaluation-timeout-help" : undefined}
                      onChange={(e) => setTimeout(e.target.value)}
                    />
                    {timeoutHelp && (
                      <span id="evaluation-timeout-help" className="muted">
                        {timeoutHelp}
                      </span>
                    )}
                  </div>
                </div>
                <label className="bench-field">
                  Folder
                  <input
                    className="input"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="Optional, e.g. gui/experiments"
                  />
                </label>
                <PresetConditions capabilities={capabilities} values={environmentRows} />
                {!planned && (
                  <CompatibilityRefresh loading={refreshing} onRefresh={refreshChecks} />
                )}
                <div className="bench-review-methods">
                  {drafts.map((d) => {
                    const policy = reviewedPolicies?.get(d.name.trim());
                    const baseline = policyBaselines.get(d.policyRef);
                    const originalPolicy = original?.spec.methods.find(
                      (method) => method.policyRef === d.policyRef,
                    )?.policySnapshot;
                    const priorPolicy = originalPolicy ?? baseline?.definition;
                    const policyChanged =
                      policy &&
                      (originalPolicy
                        ? policyRegistrationChanged(policy.definition, originalPolicy)
                        : baseline && policy.digest !== baseline.digest);
                    const resources =
                      policy &&
                      reviewValues(
                        policyResourceValues(policy.definition.service),
                        priorPolicy ? policyResourceValues(priorPolicy.service) : undefined,
                        "No restriction",
                      );
                    return (
                      <div key={d.id}>
                        <b>{d.name}</b>
                        <span className="muted">
                          {" "}
                          · {typeLabel(d.agent)}
                          {d.policyRef ? ` · ${d.policyRef}` : ""}
                          {policy ? ` · ${policy.definition.version}` : ""}
                          {d.model ? ` · ${d.model}` : ""}
                        </span>
                        {policy && (
                          <div className="muted">
                            Registration digest{" "}
                            <code title={policy.digest}>{policy.digest.slice(0, 19)}</code>
                          </div>
                        )}
                        {policyChanged && (
                          <div className="muted">
                            Policy registration changed. This evaluation will use the current
                            registration.
                          </div>
                        )}
                        {resources && (
                          <div className="muted">
                            Model service resources ·{" "}
                            {resources
                              .map(({ label, ...value }) => `${label} ${reviewValueText(value)}`)
                              .join(" · ")}
                          </div>
                        )}
                        {d.entrypoint && <div className="mono muted">{d.entrypoint}</div>}
                        {status(d)}
                      </div>
                    );
                  })}
                </div>
                <details>
                  <summary>Advanced evaluation options</summary>
                  <div className="col" style={{ gap: 8, marginTop: 8 }}>
                    <label className="bench-field">
                      Adapter options (JSON)
                      <textarea
                        className="input mono"
                        rows={3}
                        value={options}
                        onChange={(e) => setOptions(e.target.value)}
                      />
                    </label>
                    <p className="muted">
                      String values only. Keep this empty unless your adapter supports
                      per-evaluation options. Environment presets are configured separately.
                    </p>
                    {source?.spec.checkpoint && (
                      <div>
                        <p className="muted">
                          Checkpoint policy copied from the original evaluation:
                        </p>
                        <pre className="mono">
                          {JSON.stringify(source.spec.checkpoint, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
                <p className="muted">
                  {planned
                    ? "Every configuration runs the samples in the frozen plan."
                    : `All selected tasks run with every configuration for ${seeds || "—"} repetition(s).`}{" "}
                  Scheduling uses the environment’s resource settings. Setup and model connectivity
                  are checked during execution.
                </p>
              </div>
            </section>
          )}
          {error && (
            <div className="callout" role="alert">
              {error}
            </div>
          )}
          <div className="row bench-wrap bench-launch-actions">
            <Link className="btn ghost" href="/bench">
              Cancel
            </Link>
            <div className="spacer" />
            {planned && (stage === 2 || (stage === 1 && info.error)) && (
              <button
                type="button"
                className="btn"
                disabled={submitting || info.loading}
                onClick={() => {
                  setError(null);
                  info.reload();
                }}
              >
                Refresh environment
              </button>
            )}
            {planned && (stage === 1 || (stage === 2 && error)) && (
              <button
                type="button"
                className="btn"
                disabled={submitting || (configuringPolicies && policies.loading)}
                onClick={refreshPolicies}
              >
                Refresh policies
              </button>
            )}
            {stage > 0 && (
              <button
                type="button"
                className="btn"
                disabled={submitting}
                onClick={() => {
                  setStage((s) => s - 1);
                  setError(null);
                }}
              >
                Back
              </button>
            )}
            {stage < 2 ? (
              <button
                type="button"
                className="btn primary"
                disabled={
                  !current ||
                  info.loading ||
                  Boolean(info.error) ||
                  !registered ||
                  readingPlan ||
                  (configuringPolicies && policies.loading) ||
                  (stage === 1 && blocked)
                }
                onClick={next}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                disabled={
                  submitting ||
                  blocked ||
                  info.loading ||
                  Boolean(info.error) ||
                  !current ||
                  !registered
                }
                onClick={() => void submit()}
              >
                {submitting ? "Starting…" : calibration ? "Start calibration" : "Start evaluation"}
              </button>
            )}
          </div>
        </div>
        <aside className="card bench-launch-summary" aria-label="Evaluation summary">
          <div className="card-h">Evaluation summary</div>
          <div className="card-b col" style={{ gap: 14 }}>
            <dl className="kv">
              <dt>Environment</dt>
              <dd>{benchmark || "Not selected"}</dd>
              <dt>Tasks</dt>
              <dd>{selected.length}</dd>
              <dt>Configurations</dt>
              <dd>{drafts.length}</dd>
              <dt>{planned ? "Samples" : "Repetitions"}</dt>
              <dd>{planned ? sampleCount : seeds || "—"}</dd>
              <dt>Trials</dt>
              <dd>
                <b>{count}</b>
              </dd>
              <dt>Timeout</dt>
              <dd>
                {timeoutMin === null
                  ? "Invalid timeout"
                  : timeoutMin === undefined
                    ? "Environment preset"
                    : `${timeoutMin} min / ${planned ? "sample" : "solve"}`}
              </dd>
            </dl>
            <p className="muted">
              {planned
                ? `${sampleCount} samples × ${drafts.length} configurations`
                : `${selected.length} tasks × ${drafts.length} configurations × ${seeds || "—"} repetitions`}
            </p>
            {planned &&
            stage === 2 &&
            current &&
            (current.resourceOverrides || resourcesChanged) ? (
              <ReviewedResources
                key={current.benchmarkDigest}
                rows={taskResources}
                changed={resourcesChanged}
              />
            ) : (
              reviewedRegistration?.resources && (
                <p className="muted">Resource limits come from the registered per-task settings.</p>
              )
            )}
            {capabilities?.rescore === "evidence" && (
              <p className="muted">
                Later verification checks saved evidence; it does not rerun the environment.
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function ReviewedResources({
  rows,
  changed,
}: {
  rows: ReturnType<typeof taskResourceReview>;
  changed: boolean;
}) {
  return rows.length ? (
    <details open={changed ? true : undefined}>
      <summary>Registered resource overrides</summary>
      <dl className="bench-resource-overrides">
        {rows.map(({ task, values }) => (
          <div key={task}>
            <dt>{task}</dt>
            <dd>
              {values
                .map(({ label, ...value }) => `${label} ${reviewValueText(value)}`)
                .join(" · ")}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  ) : (
    <p className="muted">Selected tasks use the environment's resource defaults.</p>
  );
}

function reviewValueText({ value, previous }: Pick<ReviewValue, "value" | "previous">): string {
  return previous === undefined ? value : `${previous} → ${value}`;
}

function PresetConditions({
  capabilities,
  values,
}: {
  capabilities?: BenchCapabilities;
  values?: ReviewValue[];
}) {
  if (!capabilities)
    return (
      <p className="muted">
        This adapter does not declare its capabilities. Unsupported configurations will be rejected
        by the adapter.
      </p>
    );
  return (
    <div className="bench-preset">
      <p className="muted">Environment preset · read-only</p>
      <dl className="kv">
        {(values ?? reviewValues(capabilities.conditions, undefined, "not recorded")).map((row) => (
          <div key={row.label} style={{ display: "contents" }}>
            <dt>{row.label}</dt>
            <dd>{reviewValueText(row)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MethodEditor({
  draft: d,
  index,
  allowed,
  unavailableType,
  profiles,
  definition,
  status,
  policies,
  originalPolicy,
  onChange,
  onRemove,
}: {
  draft: MethodDraft;
  index: number;
  allowed: Method["agent"][];
  unavailableType: string;
  profiles?: AuthProfile[];
  definition?: AgentDefinition;
  status: React.ReactNode;
  policies?: PolicyDefinition[];
  originalPolicy?: PolicyDefinition;
  onChange: (patch: Partial<MethodDraft>) => void;
  onRemove?: () => void;
}) {
  const cli = isCliAgent(d.agent);
  const policy = policies?.find((p) => p.name === d.policyRef);
  const policyChanged =
    policy && originalPolicy && policyRegistrationChanged(policy, originalPolicy);
  return (
    <section className="card">
      <div className="card-h">
        Configuration {index + 1}
        <span className="spacer" />
        {onRemove && (
          <button className="btn sm ghost" type="button" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      <div className="card-b col" style={{ gap: 12 }}>
        <div className="bench-field-grid">
          <label className="bench-field">
            Name
            <input
              className="input"
              value={d.name}
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </label>
          {d.agent === "policy" ? (
            <label className="bench-field">
              Registered policy
              <select
                className="input"
                value={d.policyRef}
                onChange={(e) => onChange({ policyRef: e.target.value })}
              >
                <option value="">Select a registered policy</option>
                {d.policyRef && !policy && (
                  <option value={d.policyRef} disabled>
                    {d.policyRef} (unavailable)
                  </option>
                )}
                {policies?.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} · {p.version}
                  </option>
                ))}
              </select>
              {policyChanged && (
                <span className="muted">
                  This policy has changed since the original evaluation. Review the current
                  registration before starting.
                </span>
              )}
            </label>
          ) : (
            <label className="bench-field">
              Type
              <select
                className="input"
                value={d.agent}
                onChange={(e) => onChange({ agent: e.target.value as Method["agent"], auth: "" })}
              >
                {!allowed.includes(d.agent) && (
                  <option value={d.agent} disabled>
                    {typeLabel(d.agent)} ({unavailableType})
                  </option>
                )}
                {allowed.map((agent) => (
                  <option key={agent} value={agent}>
                    {typeLabel(agent)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {status}
        {(cli || d.agent === "external") && (
          <label className="bench-field">
            Model
            <input
              className="input"
              value={d.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder="Default configured by the agent"
            />
          </label>
        )}
        {cli && (
          <label className="bench-field">
            Auth profile
            <select
              className="input"
              aria-label="Auth profile"
              value={d.auth}
              onChange={(e) => onChange({ auth: e.target.value })}
            >
              <option value="">Select a profile</option>
              {d.auth &&
                !(profiles ?? []).some(
                  (p) => p.name === d.auth && profileAllowed(p, d.agent, definition),
                ) && (
                  <option value={d.auth} disabled>
                    {d.auth} ({profiles ? "unavailable or incompatible" : "not verified"})
                  </option>
                )}
              {(profiles ?? [])
                .filter((p) => profileAllowed(p, d.agent, definition))
                .map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
            </select>
            <span className="muted">
              Profiles are managed in <Link href="/settings">Settings</Link>.
            </span>
          </label>
        )}
        {d.agent === "external" && (
          <label className="bench-field">
            Installed policy entrypoint
            <input
              className="input mono"
              value={d.entrypoint}
              onChange={(e) => onChange({ entrypoint: e.target.value })}
              placeholder="my_policy:make_agent"
            />
          </label>
        )}
        {(cli || d.agent === "external") && (
          <details>
            <summary>Advanced configuration settings</summary>
            <div className="col" style={{ gap: 12, marginTop: 12 }}>
              <label className="bench-field">
                Effort
                <input
                  className="input"
                  value={d.effort}
                  onChange={(e) => onChange({ effort: e.target.value })}
                  placeholder="Agent default"
                />
              </label>
              {cli && (
                <label className="bench-field">
                  Prompt and skills directory
                  <input
                    className="input mono"
                    value={d.bundle}
                    onChange={(e) => onChange({ bundle: e.target.value })}
                    placeholder="Optional directory on the daemon host"
                  />
                </label>
              )}
              {d.agent === "external" && (
                <>
                  <label className="bench-field">
                    Non-secret policy configuration (JSON)
                    <textarea
                      className="input mono"
                      rows={3}
                      value={d.config}
                      onChange={(e) => onChange({ config: e.target.value })}
                    />
                  </label>
                  <label className="bench-field">
                    Pass-through variables
                    <input
                      className="input mono"
                      value={d.passEnv}
                      onChange={(e) => onChange({ passEnv: e.target.value })}
                      placeholder="MODEL_API_KEY"
                    />
                    <span className="muted">
                      Variable names only. Values must already exist in the daemon environment and
                      are passed to the solve run.
                    </span>
                  </label>
                </>
              )}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
