// Agents (design §9.16): every harness Orbit can drive, what it can do (declared / wired into
// containers / shown by a real run), its credentials and evidence, and which benchmark it can take.
import { Fragment, useState } from "react";
import { IconBot, IconCheck, IconChevron, IconChevronDown, IconX } from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading } from "../components/ui.tsx";
import {
  type AgentCatalogEntry,
  api,
  type CapabilityState,
  type CompatibilityCell,
} from "../lib/api.ts";
import { ago, dateTime, jobPath, runPath, trialPath } from "../lib/format.ts";
import { setQuery, useLocation } from "../lib/router.ts";
import { useAsync } from "../lib/use.ts";
import "./hub.css";

const CAPS: [keyof AgentCatalogEntry["capabilities"], string, string][] = [
  ["oneShot", "One-shot", "Runs one instruction to completion"],
  ["multiTurn", "Multi-turn", "Continues the same conversation"],
  ["mcp", "MCP", "Takes MCP servers (benchmark tools) in its config"],
  ["gui", "GUI", "Drives a GUI environment through the Orbit bridge"],
];

/** A capability's state: not declared, declared only, wired, or shown by a valid trial. */
export function capLevel(c: CapabilityState): "none" | "declared" | "wired" | "evidence" {
  if (!c.declared) return "none";
  if (!c.wired) return "declared";
  return c.evidence ? "evidence" : "wired";
}
const CAP_TITLE = {
  none: "not declared",
  declared: "declared, but Orbit does not wire it into containers yet",
  wired: "declared and wired; no valid trial that required it yet",
  evidence: "a valid trial of a benchmark that requires it",
};

const install = (a: AgentCatalogEntry) =>
  a.definition.install.kind === "host"
    ? a.available
      ? (a.version ?? "found on host")
      : "not found on host"
    : a.definition.install.kind === "image"
      ? "provided by the task image"
      : "installed in each run";

export function AgentsPage() {
  const loc = useLocation();
  const tab =
    (["agents", "compatibility", "external"] as const).find((t) => t === loc.query.get("tab")) ??
    "agents";
  const cat = useAsync(() => api.agentCatalog(), [], { poll: true, pollMs: 15000 });
  const agents = cat.data?.agents ?? [];
  const evidenced = agents.filter((a) => a.evidence).length;
  const mcp = agents.filter((a) => a.capabilities.mcp.wired).length;
  const gui = agents.filter((a) => a.capabilities.gui.wired).length;
  const withAuth = agents.filter((a) => a.profiles.length).length;
  const tabBtn = (t: typeof tab, label: string) => (
    <button
      type="button"
      className={`btn sm${tab === t ? " on" : " ghost"}`}
      aria-pressed={tab === t}
      onClick={() => setQuery({ tab: t === "agents" ? null : t, open: null })}
    >
      {label}
    </button>
  );
  return (
    <>
      <TopBar crumbs={[{ label: "Agents" }]}>
        <Link className="btn sm" href="/settings">
          Credentials
        </Link>
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          {cat.error && !cat.data ? (
            <div className="callout" role="alert">
              {cat.error}
            </div>
          ) : !cat.data ? (
            <Loading what="Loading Agents" />
          ) : (
            <>
              <div className="hub-stats">
                <div className="hub-stat">
                  <b className="num">{agents.length}</b>
                  <span>agents</span>
                  <small className="faint">
                    {agents.filter((a) => a.definition.origin === "builtin").length} built in ·{" "}
                    {agents.filter((a) => a.definition.origin !== "builtin").length} yours
                  </small>
                </div>
                <div className="hub-stat good">
                  <b className="num">{evidenced}</b>
                  <span>with evidence here</span>
                  <small className="faint">a valid trial or a passed auth test</small>
                </div>
                <div className="hub-stat">
                  <b className="num">{mcp}</b>
                  <span>MCP wired</span>
                  <small className="faint">
                    {agents.filter((a) => a.capabilities.mcp.declared).length} declare it
                  </small>
                </div>
                <div className="hub-stat">
                  <b className="num">{gui}</b>
                  <span>GUI capable</span>
                  <small className="faint">can drive browser / desktop tasks</small>
                </div>
                <div className="hub-stat">
                  <b className="num">{withAuth}</b>
                  <span>with credentials</span>
                  <small className="faint">auth profiles on this node</small>
                </div>
              </div>
              <div className="row bench-wrap">
                {tabBtn("agents", `Agents ${agents.length}`)}
                {tabBtn("compatibility", "Agent × benchmark")}
                {tabBtn("external", `External policies ${cat.data.external.length}`)}
              </div>
              {tab === "agents" && <AgentTable agents={agents} />}
              {tab === "compatibility" && <Compatibility />}
              {tab === "external" && <ExternalTable rows={cat.data.external} />}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function CapPills({ a }: { a: AgentCatalogEntry }) {
  return (
    <span className="cap-pills">
      {CAPS.map(([k, label, what]) => {
        const lvl = capLevel(a.capabilities[k]);
        if (lvl === "none") return null;
        return (
          <span
            key={k}
            className={`cap-pill cap-${lvl}`}
            title={`${label}: ${what} — ${CAP_TITLE[lvl]}`}
          >
            {lvl === "evidence" && <IconCheck size={11} />}
            {label}
            {lvl === "declared" && <small> · not wired</small>}
          </span>
        );
      })}
    </span>
  );
}

function AgentTable({ agents }: { agents: AgentCatalogEntry[] }) {
  const loc = useLocation();
  const open = loc.query.get("open");
  const sorted = [...agents].sort(
    (a, b) =>
      Number(Boolean(b.evidence)) - Number(Boolean(a.evidence)) ||
      b.usage.jobs - a.usage.jobs ||
      a.definition.name.localeCompare(b.definition.name),
  );
  return (
    <section className="card">
      <div className="matrix-wrap">
        <table className="table hub-table agent-table">
          <colgroup>
            <col style={{ width: 34 }} />
            <col />
            <col style={{ width: 170 }} />
            <col style={{ width: 260 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 200 }} />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>Agent</th>
              <th>On this node</th>
              <th>Capabilities</th>
              <th>Credentials</th>
              <th>Evidence</th>
              <th className="r">Used</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const name = a.definition.name;
              const isOpen = open === name;
              const toggle = () => setQuery({ open: isOpen ? null : name });
              return (
                <Fragment key={name}>
                  <tr className={`click${isOpen ? " sel" : ""}`} onClick={toggle}>
                    <td className="catalog-toggle">
                      <button
                        type="button"
                        className="btn ghost sm icon"
                        aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`}
                        aria-expanded={isOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle();
                        }}
                      >
                        {isOpen ? <IconChevronDown size={15} /> : <IconChevron size={15} />}
                      </button>
                    </td>
                    <td>
                      <b className="mono">{name}</b>
                      {a.definition.origin !== "builtin" && <span className="chip">yours</span>}
                      <div className="catalog-sub">{a.definition.description}</div>
                    </td>
                    <td>
                      <span className={a.available ? "" : "bad-text"}>{install(a)}</span>
                      <div className="faint catalog-sub">{a.definition.install.kind}</div>
                    </td>
                    <td>
                      <CapPills a={a} />
                    </td>
                    <td>
                      {a.profiles.length ? (
                        <>
                          {a.profiles.length} profile{a.profiles.length === 1 ? "" : "s"}
                          {(() => {
                            const t = a.profiles
                              .map((p) => p.test)
                              .filter(Boolean)
                              .sort((x, y) => ((x?.at ?? "") < (y?.at ?? "") ? 1 : -1))[0];
                            return t ? (
                              <div className={`catalog-sub ${t.ok ? "" : "bad-text"}`}>
                                last test {t.ok ? "passed" : "failed"} {ago(t.at)}
                              </div>
                            ) : (
                              <div className="faint catalog-sub">not tested</div>
                            );
                          })()}
                        </>
                      ) : (
                        <span className="faint">none</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Evidence a={a} />
                    </td>
                    <td className="r">
                      {a.usage.jobs ? (
                        <>
                          <span className="num">{a.usage.jobs}</span> job
                          {a.usage.jobs === 1 ? "" : "s"}
                          <div className="faint catalog-sub">
                            {a.usage.benchmarks.length} benchmark
                            {a.usage.benchmarks.length === 1 ? "" : "s"}
                          </div>
                        </>
                      ) : (
                        <span className="faint">never</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="catalog-detail-row">
                      <td colSpan={7}>
                        <AgentDetail a={a} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="card-b faint hub-legend">
        <span className="cap-pill cap-evidence">
          <IconCheck size={11} />
          shown
        </span>
        a valid trial needed it ·<span className="cap-pill cap-wired">wired</span>
        Orbit delivers it ·<span className="cap-pill cap-declared">declared</span>
        the definition says so, not wired yet
      </div>
    </section>
  );
}

function Evidence({ a }: { a: AgentCatalogEntry }) {
  const e = a.evidence;
  if (!e) return <span className="faint">no run here yet</span>;
  if (e.kind === "trial" && e.job)
    return (
      <>
        <Link href={trialPath(e.job, e.ref)} className="good-text">
          valid trial
        </Link>{" "}
        <span className="faint">on {e.benchmark}</span>
        <div className="faint catalog-sub">{ago(e.at)}</div>
      </>
    );
  return (
    <>
      <Link href={runPath(e.ref)}>auth test passed</Link>
      <div className="faint catalog-sub">{ago(e.at)} · model replied</div>
    </>
  );
}

function AgentDetail({ a }: { a: AgentCatalogEntry }) {
  const d = a.definition;
  return (
    <div className="catalog-detail">
      <div className="catalog-columns">
        <div>
          <div className="catalog-h">Capabilities</div>
          <table className="table">
            <tbody>
              {CAPS.map(([k, label, what]) => {
                const c = a.capabilities[k];
                return (
                  <tr key={k}>
                    <td>
                      <b>{label}</b>
                      <div className="faint catalog-sub">{what}</div>
                    </td>
                    <td>{c.declared ? "declared" : <span className="faint">—</span>}</td>
                    <td>
                      {c.declared ? (
                        c.wired ? (
                          "wired"
                        ) : (
                          <span className="warn-text">not wired</span>
                        )
                      ) : (
                        ""
                      )}
                    </td>
                    <td>{c.evidence ? <span className="good-text">shown by a trial</span> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="catalog-h" style={{ marginTop: 12 }}>
            Definition
          </div>
          <dl className="kv">
            <dt>Install</dt>
            <dd className="mono">
              {d.install.kind}
              {d.install.kind === "install" ? ` · ${d.install.script.slice(0, 120)}` : ""}
            </dd>
            <dt>Detail</dt>
            <dd>{a.detail}</dd>
            <dt>Auth kinds</dt>
            <dd>{d.auth.kinds.join(", ")}</dd>
            <dt>MCP wiring</dt>
            <dd className="mono">{d.command.mcp.kind}</dd>
            <dt>Transcript</dt>
            <dd className="mono">{d.command.transcript ? d.command.transcript.format : "none"}</dd>
            <dt>Command</dt>
            <dd className="mono">{d.command.run.join(" ")}</dd>
          </dl>
        </div>
        <div>
          <div className="catalog-h">Credentials</div>
          {a.profiles.length ? (
            <ul className="catalog-reasons">
              {a.profiles.map((p) => (
                <li key={p.name}>
                  <b className="mono">{p.name}</b> <span className="faint">{p.kind}</span>
                  <div className="catalog-sub">
                    {p.test ? (
                      <>
                        <Link
                          href={runPath(p.test.run)}
                          className={p.test.ok ? "good-text" : "bad-text"}
                        >
                          test {p.test.ok ? "passed" : "failed"}
                        </Link>{" "}
                        <span className="faint">{dateTime(p.test.at)}</span>
                      </>
                    ) : (
                      <span className="faint">
                        not tested — <code>orbit auth test {p.name}</code>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No auth profile. Add one on the daemon host:{" "}
              <code>
                orbit auth add NAME --harness {d.name} --kind {d.auth.kinds[0]}
              </code>
            </p>
          )}
          <div className="catalog-h" style={{ marginTop: 12 }}>
            Benchmarks it ran
          </div>
          {a.usage.benchmarks.length ? (
            <p>
              {a.usage.benchmarks.map((b) => (
                <Link key={b} className="chip link" href={`/benchmarks?q=${encodeURIComponent(b)}`}>
                  {b}
                </Link>
              ))}
            </p>
          ) : (
            <p className="faint">None yet.</p>
          )}
          <p className="faint">
            {a.usage.trials} trials, {a.usage.valid} valid
            {a.usage.lastAt ? ` · last ${ago(a.usage.lastAt)}` : ""}.
          </p>
        </div>
      </div>
    </div>
  );
}

const CELL: Record<CompatibilityCell["state"], { mark: string; label: string }> = {
  ran: { mark: "", label: "ran" },
  allowed: { mark: "✓", label: "allowed" },
  "needs-auth": { mark: "key", label: "needs credentials" },
  blocked: { mark: "×", label: "blocked" },
  unknown: { mark: "?", label: "unknown" },
};

function Compatibility() {
  const m = useAsync(() => api.benchCompatibility(), [], { poll: true, pollMs: 15000 });
  const [all, setAll] = useState(false);
  const [selection, setSelection] = useState<{ agent: string; benchmark: string } | null>(null);
  if (m.error) return <div className="callout">{m.error}</div>;
  if (!m.data) return <Loading what="Checking compatibility" />;
  if (!m.data.rows.length)
    return <Empty title="No benchmarks registered" icon={<IconBot size={32} />} />;
  const selected = selection
    ? m.data.rows.find((r) => r.benchmark === selection.benchmark)?.cells[selection.agent]
    : null;
  // By default only Agents that some benchmark admits or that ran something.
  const agents = m.data.agents.filter(
    (a) =>
      all ||
      m.data?.rows.some(
        (r) =>
          (r.cells[a]?.valid ?? 0) > 0 ||
          ["ran", "allowed", "needs-auth"].includes(r.cells[a]?.state ?? ""),
      ),
  );
  return (
    <section className="card">
      <div className="card-h">
        Which Agent can take which benchmark
        <span className="sub">configuration compatibility, capabilities and credentials</span>
        <span className="spacer" />
        <label className="row faint" style={{ gap: 6, fontWeight: 400 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Show every Agent
        </label>
      </div>
      <div className="matrix-wrap">
        <table className="table compat">
          <thead>
            <tr>
              <th>Benchmark</th>
              {agents.map((a) => (
                <th key={a} className="c mono">
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.data.rows.map((r) => (
              <tr key={r.benchmark}>
                <th scope="row" className="mono">
                  {r.benchmark}
                </th>
                {agents.map((a) => {
                  const c = r.cells[a] ?? { state: "unknown" as const };
                  const title = `${a} on ${r.benchmark}: ${CELL[c.state].label}${c.reason ? ` — ${c.reason}` : ""}`;
                  return (
                    <td key={a} className={`c compat-${c.state}`} title={title}>
                      <button
                        type="button"
                        className="compat-cell"
                        aria-label={title}
                        aria-pressed={selection?.agent === a && selection.benchmark === r.benchmark}
                        onClick={() => setSelection({ agent: a, benchmark: r.benchmark })}
                      >
                        {c.state === "ran" ? (
                          `${c.valid}/${c.trials}`
                        ) : c.state === "blocked" ? (
                          <IconX size={12} />
                        ) : (
                          CELL[c.state].mark
                        )}
                        {c.state !== "ran" && (c.valid ?? 0) > 0 && (
                          <small>{c.valid} valid before</small>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && selection && (
        <div className="card-b compat-detail" role="status">
          <b>
            {selection.agent} × {selection.benchmark}
          </b>
          <span>
            {CELL[selected.state].label}
            {selected.reason
              ? `: ${selected.reason}`
              : ": passes the configuration checks; task resources and environment are checked when starting."}
          </span>
          {selected.job && (
            <Link href={jobPath(selected.job)}>
              View latest valid evidence ({selected.valid}/{selected.trials} trials)
            </Link>
          )}
        </div>
      )}
      <div className="card-b faint hub-legend">
        <span className="compat-ran">n/m</span> valid trials · click a cell for details ·{" "}
        <span className="compat-allowed-mark">✓</span> allowed · <b>key</b> allowed, needs an auth
        profile · <IconX size={11} /> blocked · ? listing not available
      </div>
    </section>
  );
}

function ExternalTable({
  rows,
}: {
  rows: { entrypoint: string; benchmarks: string[]; jobs: number; lastAt: string }[];
}) {
  if (!rows.length)
    return (
      <Empty title="No external policy has run yet">
        External configurations use adapter-owned entrypoints (a VLA policy server, a scripted GUI
        policy).
      </Empty>
    );
  return (
    <section className="card matrix-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Entrypoint</th>
            <th>Benchmarks</th>
            <th className="r">Jobs</th>
            <th className="r">Last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entrypoint}>
              <td className="mono">{r.entrypoint}</td>
              <td>{r.benchmarks.join(", ")}</td>
              <td className="r num">{r.jobs}</td>
              <td className="r faint">{ago(r.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
