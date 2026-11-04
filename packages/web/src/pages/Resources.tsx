import { PALETTE } from "../components/Chart.tsx";
import { IconAlert, IconChip } from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading, StateIcon } from "../components/ui.tsx";
import {
  api,
  type Gpu,
  type GpuProcess,
  type Lease,
  type NodeResources,
  type NodeStatus,
  type Run,
} from "../lib/api.ts";
import { ago, dateTime, duration, queuedFor, runPath, runTitle } from "../lib/format.ts";
import { setQuery, useLocation } from "../lib/router.ts";
import { useRuns } from "../lib/runs-store.ts";
import { useAsync } from "../lib/use.ts";

const pct = (a: number, b: number) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
const gib = (mib: number) => (mib / 1024).toFixed(mib >= 10240 ? 0 : 1);

export function Resources() {
  const ledger = useAsync(() => api.ledger(), [], { poll: true, pollMs: 3000 });
  const runs = useRuns();
  const loc = useLocation();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const d = ledger.data;
  if (!d)
    return ledger.error ? (
      <Empty title="Could not read resources">{ledger.error}</Empty>
    ) : (
      <Loading />
    );

  const local = d.resources.node;
  const worker = d.nodes.find((n) => n.name === loc.query.get("node")) ?? null;
  const pick = (name: string | null) => setQuery({ node: name });
  const probedAt = worker ? worker.info?.resources.probedAt : d.resources.probedAt;

  return (
    <>
      <TopBar crumbs={[{ label: "Resources" }, { label: worker?.name ?? local }]}>
        {d.nodes.length > 0 && (
          <div className="seg" role="tablist" aria-label="Node">
            <button
              type="button"
              role="tab"
              aria-selected={!worker}
              className={worker ? "" : "on"}
              onClick={() => pick(null)}
              title="This node"
            >
              {local}
            </button>
            {d.nodes.map((n) => (
              <button
                key={n.name}
                type="button"
                role="tab"
                aria-selected={worker?.name === n.name}
                className={worker?.name === n.name ? "on" : ""}
                onClick={() => pick(n.name)}
                title={`${n.url} · ${n.online ? "online" : "offline"}`}
              >
                <NodeDot online={n.online} /> {n.name}
              </button>
            ))}
          </div>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          {probedAt ? `probed ${ago(probedAt)}` : "no report yet"} · refreshes every 3 s
        </span>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          {worker ? (
            <WorkerDetail n={worker} runs={runs} byId={byId} />
          ) : (
            <>
              <NodeDetail
                res={d.resources}
                leases={d.leases}
                queued={d.queued.length}
                byId={byId}
              />
              {d.nodes.length > 0 && <Nodes nodes={d.nodes} runs={runs} onOpen={pick} />}
              <section className="card">
                <div className="card-h">
                  Queue <span className="sub">{d.queued.length}</span>
                </div>
                {d.queued.length === 0 ? (
                  <div className="card-b faint">
                    Nothing waiting. Runs that cannot get resources wait here instead of failing.
                  </div>
                ) : (
                  <QueueTable
                    rows={d.queued.map((q) => ({ id: q.runId, reason: q.reason }))}
                    byId={byId}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const NodeDot = ({ online }: { online: boolean }) => (
  <span
    className="node-dot"
    style={{ background: online ? "var(--st-succeeded)" : "var(--st-failed)" }}
  />
);

/**
 * One node's resources: stat cards, GPU cards and active leases. Leases of runs this node does not
 * know (a worker's own runs, or runs from another primary) are listed without a link.
 */
function NodeDetail({
  res,
  leases,
  queued,
  byId,
}: {
  res: NodeResources;
  leases: Lease[];
  queued: number;
  byId: Map<string, Run>;
}) {
  const active = leases.filter((l) => l.state === "active");
  const owner = new Map<string, Lease>();
  for (const l of active) for (const g of l.gpuIds) owner.set(g, l);
  const leaseColor = new Map(active.map((l, i) => [l.id, PALETTE[i % PALETTE.length] as string]));
  const leasedCpus = active.reduce((a, l) => a + l.cpus, 0);
  const leasedMem = active.reduce((a, l) => a + l.memGB, 0);
  const freeGpus = res.gpus.filter((g) => g.available && !owner.has(g.uuid)).length;
  const external = res.gpus.filter((g) => !g.available && !owner.has(g.uuid)).length;

  return (
    <>
      <div className="stats">
        <Stat
          v={`${freeGpus} / ${res.gpus.length}`}
          l={`GPUs free${external ? ` · ${external} busy outside Orbit` : ""}`}
          frac={res.gpus.length ? 1 - freeGpus / res.gpus.length : 0}
        />
        <Stat
          v={`${leasedCpus} / ${res.cpu.count}`}
          l={`CPUs leased · ${res.cpu.busy.toFixed(0)} in use · load ${res.cpu.load1.toFixed(1)}`}
          frac={leasedCpus / res.cpu.count}
          used={res.cpu.busy / res.cpu.count}
        />
        <Stat
          v={`${(res.memory.totalGB - res.memory.availableGB).toFixed(0)} / ${res.memory.totalGB.toFixed(0)} GB`}
          l={`memory used · ${leasedMem} GB leased`}
          frac={1 - res.memory.availableGB / res.memory.totalGB}
        />
        <Stat
          v={`${res.disk.freeGB.toFixed(0)} GB`}
          l={`disk free · ${res.disk.path}`}
          frac={1 - res.disk.freeGB / res.disk.totalGB}
        />
        <Stat v={String(queued)} l="runs queued" />
      </div>

      <section className="col" style={{ gap: 8 }}>
        <h3 className="section-title">GPUs</h3>
        {res.gpuError && (
          <div className="callout" style={{ "--c": "var(--st-cancelled)" } as React.CSSProperties}>
            <IconAlert size={15} /> {res.gpuError}
          </div>
        )}
        {res.gpus.length === 0 ? (
          <Empty title="No GPUs detected" icon={<IconChip size={28} />} />
        ) : (
          <div className="gpus">
            {res.gpus.map((g) => (
              <GpuTile
                key={g.uuid}
                g={g}
                lease={owner.get(g.uuid)}
                run={byId.get(owner.get(g.uuid)?.runId ?? "")}
                color={leaseColor.get(owner.get(g.uuid)?.id ?? "")}
                byId={byId}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-h">Devices</div>
        {!res.devices?.length ? (
          <div className="card-b faint">No device capabilities reported.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Available</th>
                <th>Held by</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {res.devices.map((device) => {
                const held = active.flatMap((lease) =>
                  lease.roles.flatMap((role) =>
                    (role.devices ?? [])
                      .filter((d) => d.class === device.class)
                      .map((d) => ({ lease, role: role.role, count: d.count, paths: d.paths })),
                  ),
                );
                const used = held.reduce((n, d) => n + d.count, 0);
                const free = device.exclusive && used ? 0 : Math.max(0, device.count - used);
                return (
                  <tr key={device.class}>
                    <td className="mono">
                      {device.class}
                      {device.exclusive && <span className="faint"> · exclusive</span>}
                    </td>
                    <td className="num">
                      {free} / {device.count}
                    </td>
                    <td>
                      {held.length ? (
                        held.map((d) => (
                          <div key={`${d.lease.id}-${d.role}`} title={d.paths.join(", ")}>
                            <RunCell id={d.lease.runId} run={byId.get(d.lease.runId)} />
                            <span className="faint mono">
                              {d.role} · {d.count} leased
                            </span>
                          </div>
                        ))
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="muted">{device.detail ?? device.paths.join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-h">
          Active leases <span className="sub">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <div className="card-b faint">No active leases.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>GPUs</th>
                <th>Devices</th>
                <th className="r">CPUs</th>
                <th className="r">Memory</th>
                <th className="r">Held for</th>
              </tr>
            </thead>
            <tbody>
              {active.map((l) => (
                <tr key={l.id}>
                  <td>
                    <RunCell id={l.runId} run={byId.get(l.runId)} color={leaseColor.get(l.id)} />
                  </td>
                  <td className="mono">
                    {l.gpuIds
                      .map((u) => `#${res.gpus.find((g) => g.uuid === u)?.index ?? "?"}`)
                      .join(" ") || "—"}
                  </td>
                  <td className="mono">
                    {l.roles
                      .flatMap((r) =>
                        (r.devices ?? []).map((d) => `${r.role}: ${d.count} ${d.class}`),
                      )
                      .join(", ") || "—"}
                  </td>
                  <td className="r num">{l.cpus}</td>
                  <td className="r num">{l.memGB} GB</td>
                  <td className="r num muted">{duration(Date.now() - Date.parse(l.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** A worker as its last heartbeat reported it, with the runs this node has waiting there. */
function WorkerDetail({ n, runs, byId }: { n: NodeStatus; runs: Run[]; byId: Map<string, Run> }) {
  const i = n.info;
  const ours = runs.filter((r) => r.remote && r.node === n.name);
  // A run placed there but still waiting in the worker's own queue.
  const waiting = ours.filter((r) => r.state === "starting" && !r.startedAt);
  const running = ours.filter(
    (r) => r.state === "running" || (r.state === "starting" && r.startedAt),
  );
  return (
    <>
      {(!n.online || n.error) && (
        <div className="callout" style={{ "--c": "var(--st-failed)" } as React.CSSProperties}>
          <IconAlert size={15} />
          {n.online ? "" : "Offline. "}
          {n.error ?? ""}
          {i &&
            !n.online &&
            ` Showing the last report (${n.lastSeen ? ago(n.lastSeen) : "never"}).`}
        </div>
      )}
      <section className="card">
        <div className="card-h">
          <NodeDot online={n.online} /> {n.name}
          <span className="sub mono">{n.url}</span>
        </div>
        <div className="card-b">
          <dl className="kv">
            <dt>Orbit</dt>
            <dd className="mono">{i ? `${i.version} · protocol ${i.protocol}` : "—"}</dd>
            <dt>Last report</dt>
            <dd>{n.lastSeen ? `${ago(n.lastSeen)} (${dateTime(n.lastSeen)})` : "never"}</dd>
            <dt>Our runs there</dt>
            <dd>
              {running.length} running · {waiting.length} waiting in its queue
              {i ? ` · ${i.queued} queued there in total` : ""}
            </dd>
            <dt>Datasets</dt>
            <dd className="mono">{i?.datasets.join(", ") || "—"}</dd>
            <dt>Auth profiles</dt>
            <dd>
              {i?.profiles.length ? (
                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {i.profiles.map((p) => (
                    <span
                      key={p.name}
                      className={`chip mono ${p.cli ? "" : "warn"}`}
                      title={
                        p.cli
                          ? `${p.harness} CLI installed`
                          : `${p.harness} CLI missing: runs with this profile are not placed here`
                      }
                    >
                      {p.name} · {p.harness}
                      {p.cli ? "" : " · no CLI"}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="faint">none (runs with --auth are not placed here)</span>
              )}
            </dd>
          </dl>
        </div>
      </section>
      {i ? (
        <NodeDetail res={i.resources} leases={i.leases} queued={i.queued} byId={byId} />
      ) : (
        <Empty title={`No report from ${n.name} yet`} icon={<IconChip size={28} />}>
          The primary asks every node for its resources every few seconds.
        </Empty>
      )}
      {waiting.length > 0 && (
        <section className="card">
          <div className="card-h">
            Our runs waiting on {n.name} <span className="sub">{waiting.length}</span>
          </div>
          <QueueTable rows={waiting.map((r) => ({ id: r.id, reason: r.reason }))} byId={byId} />
        </section>
      )}
    </>
  );
}

function QueueTable({
  rows,
  byId,
}: {
  rows: { id: string; reason: string | null }[];
  byId: Map<string, Run>;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 40 }}>#</th>
          <th>Run</th>
          <th>Requested</th>
          <th>Waiting because</th>
          <th className="r">Waiting</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((q, i) => {
          const r = byId.get(q.id);
          const rq = r?.spec.resources;
          const devices = r
            ? [
                ...(r.spec.devices?.length ? r.spec.devices : (rq?.devices ?? [])),
                ...r.spec.services.flatMap((s) => s.devices ?? []),
              ]
                .map((d) => `${d.count} ${d.class}`)
                .join(", ")
            : "";
          return (
            <tr key={q.id}>
              <td className="faint num">{i + 1}</td>
              <td>
                <RunCell id={q.id} run={r} />
              </td>
              <td className="mono muted">
                {rq
                  ? `${rq.gpus} GPU${rq.gpuMemGB ? ` ≥${rq.gpuMemGB}G` : ""} · ${rq.cpus} CPU · ${rq.memGB} GB${devices ? ` · ${devices}` : ""}`
                  : "—"}
              </td>
              <td>{q.reason ?? "—"}</td>
              <td className="r num muted">{r ? duration(queuedFor(r)) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Worker nodes this daemon places runs on: their resources as last reported; a row opens its detail. */
function Nodes({
  nodes,
  runs,
  onOpen,
}: {
  nodes: NodeStatus[];
  runs: Run[];
  onOpen: (name: string) => void;
}) {
  return (
    <section className="card">
      <div className="card-h">
        Worker nodes{" "}
        <span className="sub">
          {nodes.filter((n) => n.online).length} online · click a node for its detail
        </span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Node</th>
            <th>GPUs free</th>
            <th className="r">CPUs leased · in use</th>
            <th className="r">Memory</th>
            <th className="r">Our runs</th>
            <th>Datasets</th>
            <th className="r">Seen</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const i = n.info;
            const active = i?.leases.filter((l) => l.state === "active") ?? [];
            const held = new Set(active.flatMap((l) => l.gpuIds));
            const free = i?.resources.gpus.filter((g) => g.available && !held.has(g.uuid)).length;
            const external = i?.resources.gpus.filter(
              (g) => !g.available && !held.has(g.uuid),
            ).length;
            const ours = runs.filter(
              (r) =>
                r.remote && r.node === n.name && (r.state === "running" || r.state === "starting"),
            ).length;
            return (
              <tr key={n.name} className="click" onClick={() => onOpen(n.name)}>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <NodeDot online={n.online} />
                    <b>{n.name}</b>
                    <span className="faint mono" style={{ fontSize: 11 }}>
                      {n.url}
                    </span>
                  </div>
                  {n.error && (
                    <div className="faint" style={{ fontSize: 12 }}>
                      {n.error}
                    </div>
                  )}
                </td>
                <td className="num">
                  {i ? `${free} / ${i.resources.gpus.length}` : "—"}
                  {external ? (
                    <span className="faint"> · {external} busy outside Orbit</span>
                  ) : null}
                </td>
                <td className="r num">
                  {i
                    ? `${active.reduce((a, l) => a + l.cpus, 0)} · ${i.resources.cpu.busy.toFixed(0)} / ${i.resources.cpu.count}`
                    : "—"}
                </td>
                <td className="r num">
                  {i
                    ? `${i.resources.memory.availableGB.toFixed(0)} / ${i.resources.memory.totalGB.toFixed(0)} GB free`
                    : "—"}
                </td>
                <td className="r num">{ours}</td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {i?.datasets.join(", ") || "—"}
                </td>
                <td className="r num muted">{n.lastSeen ? ago(n.lastSeen) : "never"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** `frac` fills the main bar; `used` (measured use, e.g. CPUs) is drawn as a thin bar under it. */
function Stat({ v, l, frac, used }: { v: string; l: string; frac?: number; used?: number }) {
  const f =
    frac === undefined || !Number.isFinite(frac) ? undefined : Math.max(0, Math.min(1, frac));
  const c =
    f === undefined
      ? undefined
      : f > 0.9
        ? "var(--st-failed)"
        : f > 0.7
          ? "var(--st-cancelled)"
          : "var(--accent)";
  return (
    <div className="card card-b stat">
      <span className="v num">{v}</span>
      <span className="l ellipsis" title={l}>
        {l}
      </span>
      {f !== undefined && (
        <div className="bar" style={{ marginTop: 6 }}>
          <span
            style={
              { width: `${Math.max(0, Math.min(1, f)) * 100}%`, "--c": c } as React.CSSProperties
            }
          />
        </div>
      )}
      {used !== undefined && Number.isFinite(used) && (
        <div className="bar" style={{ marginTop: 3, height: 3 }} title="in use (all processes)">
          <span
            style={
              {
                width: `${Math.max(0, Math.min(1, used)) * 100}%`,
                "--c": "var(--text-3)",
              } as React.CSSProperties
            }
          />
        </div>
      )}
    </div>
  );
}

function RunCell({ id, run, color }: { id: string; run?: Run; color?: string }) {
  return (
    <div className="row" style={{ gap: 8, minWidth: 0 }}>
      {color && (
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: "none" }} />
      )}
      {run && <StateIcon state={run.state} size={12} />}
      {run ? (
        <Link href={`${runPath(id)}`} className="ellipsis" style={{ color: "var(--text)" }}>
          {runTitle(run)}
        </Link>
      ) : (
        <span
          className="muted"
          title="Not a run of this node (the worker's own, or another primary's)"
        >
          not ours
        </span>
      )}
      <span className="faint mono" style={{ fontSize: 11 }}>
        {id}
      </span>
    </div>
  );
}

/** `wangxuehai` or `unknown`; a uid without a /etc/passwd entry shows as `uid 1001`. */
const who = (p: GpuProcess) => p.user ?? "unknown";

/** What the process is, or why we cannot say. */
const what = (p: GpuProcess) => p.command ?? "unknown";

/** PID, container and how long the process has been running; unreadable parts stay hidden. */
function ProcessMeta({ p, now }: { p: GpuProcess; now: number }) {
  const started = p.startedAt ? Date.parse(p.startedAt) : null;
  const age =
    started !== null && Number.isFinite(started) ? duration(Math.max(0, now - started)) : null;
  return (
    <span className="faint mono" style={{ fontSize: 11 }}>
      pid {p.pid}
      {p.container ? ` · ${p.container}` : ""}
      {age ? ` · ${age}` : ""}
    </span>
  );
}

/** One process holding memory on a GPU: who, what, where and its size. */
function GpuProcessRow({ p, run, now }: { p: GpuProcess; run?: Run; now: number }) {
  return (
    <div className="gpuproc">
      <div className="col" style={{ minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: 6, minWidth: 0 }}>
          <span className="ellipsis mono" style={{ fontSize: 12 }} title={p.command ?? undefined}>
            {what(p)}
          </span>
          {p.memMiB > 0 && (
            <span className="faint num" style={{ fontSize: 11 }}>
              {gib(p.memMiB)} GiB
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {who(p)}
          </span>
          <ProcessMeta p={p} now={now} />
        </div>
      </div>
      {p.runId && <RunCell id={p.runId} run={run} />}
    </div>
  );
}

function GpuTile({
  g,
  lease,
  run,
  color,
  byId,
}: {
  g: Gpu;
  lease?: Lease;
  run?: Run;
  color?: string;
  /** Runs of this node, to link the processes that belong to one. */
  byId: Map<string, Run>;
}) {
  const now = Date.now();
  const external = !lease && !g.available;
  const status = lease ? "leased" : external ? "busy (external)" : "free";
  const c = lease ? color : external ? "var(--st-cancelled)" : "var(--st-succeeded)";
  return (
    <div className="gpu" style={{ "--c": c } as React.CSSProperties}>
      <div className="row" style={{ gap: 10 }}>
        <span className="idx">#{g.index}</span>
        <div className="col" style={{ minWidth: 0, flex: 1 }}>
          <span className="ellipsis" style={{ fontWeight: 500 }} title={g.name}>
            {g.name.replace(/^NVIDIA (GeForce )?/, "")}
          </span>
          <span className="faint mono ellipsis" style={{ fontSize: 11 }} title={g.uuid}>
            {g.uuid}
          </span>
        </div>
        <span className="chip" style={{ color: c }}>
          {status}
        </span>
      </div>
      <div className="col" style={{ gap: 4 }}>
        <div className="row muted" style={{ fontSize: 12, justifyContent: "space-between" }}>
          <span>memory</span>
          <span className="num">
            {gib(g.memUsedMiB)} / {gib(g.memTotalMiB)} GiB
          </span>
        </div>
        <div className="bar">
          <span
            style={
              {
                width: `${pct(g.memUsedMiB - g.externalMemMiB, g.memTotalMiB)}%`,
                "--c": color ?? "var(--accent)",
              } as React.CSSProperties
            }
          />
          <span
            style={
              {
                width: `${pct(g.externalMemMiB, g.memTotalMiB)}%`,
                "--c": "var(--st-cancelled)",
              } as React.CSSProperties
            }
          />
        </div>
        <div className="row muted" style={{ fontSize: 12, justifyContent: "space-between" }}>
          <span>utilization</span>
          <span className="num">{g.utilPct === null ? "—" : `${g.utilPct}%`}</span>
        </div>
        <div className="bar">
          <span style={{ width: `${g.utilPct ?? 0}%` }} />
        </div>
      </div>
      <div style={{ fontSize: 12, minHeight: 18 }}>
        {lease ? (
          <RunCell id={lease.runId} run={run} />
        ) : external ? (
          <span className="faint">
            used by a process Orbit does not own ({gib(g.externalMemMiB)} GiB)
          </span>
        ) : (
          <span className="faint">available</span>
        )}
      </div>
      {g.processes.length > 0 && (
        <div className="col gpuprocs">
          {g.processes.map((p) => (
            <GpuProcessRow
              key={`${p.pid}-${p.memMiB}`}
              p={p}
              run={p.runId ? byId.get(p.runId) : undefined}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
