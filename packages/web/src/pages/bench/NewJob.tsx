import type {
  AuthProfile,
  BenchCapabilities,
  BenchJob,
  Benchmark,
  Method,
} from "@zjunlp/orbit/contracts";
import { useState } from "react";
import { TopBar } from "../../components/TopBar.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { jobPath } from "../../lib/format.ts";
import { navigate, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import { jobLabel } from "./common.tsx";
import {
  buildMethods,
  capabilityAllows,
  copiedMethods,
  evaluationSpec,
  importMethods,
  isCliAgent,
  METHOD_TYPES,
  type MethodDraft,
  methodDraft,
  methodTypes,
  registrationChanged,
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
};
const typeLabel = (agent: string) => TYPE_LABEL[agent] ?? agent;
const STEPS = ["Environment & tasks", "Configurations", "Review & start"];

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
      <TopBar crumbs={[{ label: "Bench", href: "/bench" }, { label: "New evaluation" }]} />
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
              profiles={profiles.data ?? []}
              agentNames={agents.data?.map((a) => a.definition.name) ?? null}
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
  agentNames,
  derive,
}: {
  derive: { parent: string; method: string; informedBy: string[] };
  benchmarks: Benchmark[];
  source?: BenchJob;
  preset: string;
  subset?: string[];
  jobs: BenchJob[];
  profiles: AuthProfile[];
  profilesError: string | null;
  /** Registered Agent names; null until the daemon answers. */
  agentNames: string[] | null;
}) {
  const [stage, setStage] = useState(0);
  const [benchmark, setBenchmark] = useState(source?.spec.benchmark ?? preset);
  const [chosen, setChosen] = useState<string[] | null>(subset ?? source?.spec.tasks ?? null);
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<MethodDraft[]>(() =>
    source
      ? copiedMethods(source, derive.method, derive.parent).map(methodDraft)
      : [methodDraft({ name: "empty", agent: "empty" })],
  );
  const [lineageTarget, setLineageTarget] = useState(drafts[0]?.id ?? "");
  const lineageMethods = drafts.filter((m) => m.agent !== "oracle" && m.agent !== "empty");
  const lineageMethod = lineageMethods.find((m) => m.id === lineageTarget) ?? lineageMethods[0];
  const [name, setName] = useState(source ? `${jobLabel(source)} copy`.slice(0, 200) : "");
  const [seeds, setSeeds] = useState(String(source?.spec.seeds ?? 1));
  const [timeout, setTimeout] = useState(
    source?.spec.timeoutMin === undefined ? "" : String(source.spec.timeoutMin),
  );
  const [folder, setFolder] = useState(source?.folder ?? "");
  const [options, setOptions] = useState(JSON.stringify(source?.spec.options ?? {}, null, 2));
  const [importText, setImportText] = useState("");
  const [parent, setParent] = useState(derive.parent);
  const [note, setNote] = useState("");
  const [informedBy, setInformedBy] = useState(derive.informedBy.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const info = useAsync(
    async () => (benchmark ? { benchmark, value: await api.benchInfo(benchmark) } : null),
    [benchmark],
  );
  const current = info.data?.benchmark === benchmark ? info.data.value : undefined;
  const registered = benchmarks.find((b) => b.name === benchmark);
  const tasks = current?.tasks ?? [];
  const supported = tasks.filter((t) => t.supported);
  const selected = chosen ?? supported.map((t) => t.id);
  const visibleTasks = tasks.filter((t) =>
    `${t.id} ${t.title ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const capabilities = current?.capabilities;
  const changed = source && registered ? registrationChanged(source, registered) : false;
  const count =
    selected.length *
    drafts.length *
    (Number.isInteger(Number(seeds)) && Number(seeds) > 0 ? Number(seeds) : 0);
  const fields = { benchmark, tasks: selected, name, seeds, timeout, options };
  const types = agentNames ? methodTypes(agentNames) : METHOD_TYPES;
  const methodAllowed = capabilities
    ? types.filter((a) => capabilityAllows(capabilities.methods, a))
    : types;
  const updateMethod = (index: number, patch: Partial<MethodDraft>) =>
    setDrafts((all) => all.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const next = () => {
    try {
      if (!registered || !current || info.loading || info.error)
        throw new Error("Load a registered environment before continuing.");
      if (capabilities?.embodied)
        throw new Error(
          "This policy benchmark requires a frozen sample plan. Submit it with orbit bench run --sample-plan.",
        );
      if (stage === 0) evaluationSpec(fields, [{ name: "preview", agent: "empty" }], tasks, source);
      else buildMethods(drafts, capabilities, profiles);
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
      const spec = withLineage(
        evaluationSpec(fields, buildMethods(drafts, capabilities, profiles), tasks, source),
        { parent, note, informedBy, method: lineageMethod?.name.trim() },
      );
      setError(null);
      setSubmitting(true);
      const job = await api.benchSubmit(spec, folder.trim());
      navigate(jobPath(job.id));
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };
  const importFromText = () => {
    try {
      setDrafts(importMethods(importText));
      setError(null);
      setImportText("");
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
          Copying <Link href={jobPath(source.id)}>{jobLabel(source)}</Link>. This starts a separate
          evaluation using the selected registration.
        </div>
      )}
      {source && registered && changed !== false && (
        <div className="callout">
          {changed === null
            ? "The original environment configuration was not recorded. Review the current preset before starting."
            : "The registered environment differs from the saved configuration. This evaluation will use the current preset shown below."}
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
                    onChange={(e) => {
                      setBenchmark(e.target.value);
                      setChosen(null);
                      setSearch("");
                      setError(null);
                    }}
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
                      <button className="btn sm ghost" type="button" onClick={() => setChosen([])}>
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
              </div>
            </section>
          )}
          {stage === 1 && (
            <>
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
                      onChange={(e) => {
                        const j = jobs.find((x) => x.id === e.target.value);
                        if (j) {
                          setDrafts(j.spec.methods.map(methodDraft));
                          setError(null);
                        }
                      }}
                    >
                      <option value="">Choose an evaluation…</option>
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {jobLabel(j)} · {j.spec.benchmark}
                        </option>
                      ))}
                    </select>
                  </label>
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
                        Import non-secret settings only. API keys belong in the daemon environment,
                        referenced by variable name.
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
                  {profilesError && drafts.some((d) => isCliAgent(d.agent)) && (
                    <div className="callout">Could not load auth profiles: {profilesError}</div>
                  )}
                </div>
              </section>
              {drafts.map((draft, i) => (
                <MethodEditor
                  key={draft.id}
                  draft={draft}
                  index={i}
                  allowed={methodAllowed}
                  profiles={profiles}
                  onChange={(patch) => updateMethod(i, patch)}
                  onRemove={() => setDrafts((all) => all.filter((_, j) => j !== i))}
                />
              ))}
              <div>
                <button
                  className="btn"
                  type="button"
                  disabled={!methodAllowed.length}
                  onClick={() => {
                    const agent = methodAllowed.includes("external")
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
            </>
          )}
          {stage === 2 && (
            <section className="card">
              <div className="card-h">Review & start</div>
              <div className="card-b col" style={{ gap: 16 }}>
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
                  <label className="bench-field">
                    Solve timeout (minutes)
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="any"
                      value={timeout}
                      placeholder="Environment preset"
                      onChange={(e) => setTimeout(e.target.value)}
                    />
                  </label>
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
                <PresetConditions capabilities={capabilities} />
                <div className="bench-review-methods">
                  {drafts.map((d) => (
                    <div key={d.id}>
                      <b>{d.name}</b>
                      <span className="muted">
                        {" "}
                        · {typeLabel(d.agent)}
                        {d.model ? ` · ${d.model}` : ""}
                      </span>
                      {d.entrypoint && <div className="mono muted">{d.entrypoint}</div>}
                    </div>
                  ))}
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
                  All selected tasks run with every configuration for {seeds || "—"} repetition(s).
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
                disabled={!current || info.loading || Boolean(info.error) || !registered}
                onClick={next}
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                disabled={submitting}
                onClick={() => void submit()}
              >
                {submitting ? "Starting…" : "Start evaluation"}
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
              <dt>Repetitions</dt>
              <dd>{seeds || "—"}</dd>
              <dt>Trials</dt>
              <dd>
                <b>{count}</b>
              </dd>
              <dt>Timeout</dt>
              <dd>{timeout ? `${timeout} min / solve` : "Environment preset"}</dd>
            </dl>
            <p className="muted">
              {selected.length} tasks × {drafts.length} configurations × {seeds || "—"} repetitions
            </p>
            {registered?.resources && (
              <p className="muted">Resource limits come from the registered per-task settings.</p>
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

function PresetConditions({ capabilities }: { capabilities?: BenchCapabilities }) {
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
        {Object.entries(capabilities.conditions).map(([key, value]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>{key}</dt>
            <dd>{value}</dd>
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
  profiles,
  onChange,
  onRemove,
}: {
  draft: MethodDraft;
  index: number;
  allowed: Method["agent"][];
  profiles: AuthProfile[];
  onChange: (patch: Partial<MethodDraft>) => void;
  onRemove: () => void;
}) {
  const cli = isCliAgent(d.agent);
  return (
    <section className="card">
      <div className="card-h">
        Configuration {index + 1}
        <span className="spacer" />
        <button className="btn sm ghost" type="button" onClick={onRemove}>
          Remove
        </button>
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
          <label className="bench-field">
            Type
            <select
              className="input"
              value={d.agent}
              onChange={(e) => onChange({ agent: e.target.value as Method["agent"], auth: "" })}
            >
              {!allowed.includes(d.agent) && (
                <option value={d.agent} disabled>
                  {typeLabel(d.agent)} (unsupported)
                </option>
              )}
              {allowed.map((agent) => (
                <option key={agent} value={agent}>
                  {typeLabel(agent)}
                </option>
              ))}
            </select>
          </label>
        </div>
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
              value={d.auth}
              onChange={(e) => onChange({ auth: e.target.value })}
            >
              <option value="">Select a profile</option>
              {d.auth && !profiles.some((p) => p.name === d.auth && p.harness === d.agent) && (
                <option value={d.auth} disabled>
                  {d.auth} (unavailable)
                </option>
              )}
              {profiles
                .filter((p) => p.harness === d.agent)
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
