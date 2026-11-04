import {
  type DoctorReport,
  type FolderStat,
  type GpuProcess,
  inFolder,
  type Lease,
  type Ledger,
  type NodeResources,
  type Run,
  runDisplayName,
} from "../contracts/index.ts";

export function duration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function runDuration(r: Run, now = Date.now()): string {
  if (!r.startedAt) return "-";
  const end = r.endedAt ? Date.parse(r.endedAt) : now;
  return duration(end - Date.parse(r.startedAt));
}

export function table(rows: string[][], trim = false): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) => {
      const line = r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
      return trim ? line.trimEnd() : line;
    })
    .join("\n");
}

export function formatRuns(runs: Run[]): string {
  if (runs.length === 0) return "no runs";
  const multi = new Set(runs.map((r) => r.node)).size > 1 || runs.some((r) => r.remote);
  const rows = [["ID", "STATE", "GROUP", "NAME", "GPUS", "TIME", "COMMIT", "INFO"]];
  if (multi) rows[0]?.splice(5, 0, "NODE");
  for (const r of runs) {
    const code = r.code ? `${r.code.commit?.slice(0, 7) ?? "-"}${r.code.dirty ? "*" : ""}` : "-";
    const gpus = r.lease?.gpuIds.length
      ? String(r.lease.gpuIds.length)
      : String(r.spec.resources.gpus);
    const row = [
      r.id,
      r.state,
      r.spec.group ?? "-",
      runDisplayName(r.spec),
      gpus,
      runDuration(r),
      code,
      r.reason ?? "",
    ];
    if (multi) row.splice(5, 0, r.state === "queued" ? "-" : r.node);
    rows.push(row);
  }
  return table(rows);
}

export function formatRun(r: Run, summary?: Record<string, number>): string {
  const lines = [
    `${r.id}  ${r.state}${r.reason ? ` (${r.reason})` : ""}`,
    `  name     ${r.spec.name ?? `${runDisplayName(r.spec)} (from the command)`}   group ${r.spec.group ?? "-"}   folder ${r.folder || "-"}`,
    `  command  ${r.spec.command.join(" ")}`,
    `  image    ${r.image ?? r.spec.dockerfile ?? "-"}${r.imageId ? `  (${r.imageId.slice(0, 19)})` : ""}`,
    `  request  ${r.spec.resources.gpus} GPU, ${r.spec.resources.cpus} CPU, ${r.spec.resources.memGB} GB`,
    `  node     ${r.node}${r.remote ? " (remote; outputs stay there)" : ""}${r.origin ? ` (from ${r.origin})` : ""}`,
  ];
  if (r.spec.services.length) {
    const status = (name: string) => r.services.find((s) => s.name === name);
    const svc = r.spec.services.map((s) => {
      const st = status(s.name);
      const lim = s.cpus || s.memGB ? ` ${s.cpus ?? "-"} CPU/${s.memGB ?? "-"} GB` : "";
      return `${s.name}${lim}${st?.failure ? ` (failed: ${st.failure})` : st ? "" : " (not started)"}`;
    });
    lines.push(`  services ${svc.join(", ")}  (logs in output/services/)`);
  }
  if (r.lease)
    lines.push(
      `  lease    ${r.lease.state} ${r.lease.gpuIds.join(", ") || "no GPUs"}${r.spec.services.length ? `, ${r.lease.cpus} CPU, ${r.lease.memGB} GB with services` : ""}`,
    );
  if (r.usage) lines.push(`  usage    ${formatUsage(r)}`);
  if (r.checkpoint)
    lines.push(
      `  checkpoint ${r.checkpoint.state}${r.checkpoint.sizeBytes === null ? "" : ` ${fmtBytes(r.checkpoint.sizeBytes)}`}${r.checkpoint.reason ? `: ${r.checkpoint.reason}` : `; orbit resume ${r.id}`}`,
    );
  if (r.sizeBytes !== null) lines.push(`  disk     ${fmtBytes(r.sizeBytes)}`);
  if (r.code) {
    const c = r.code;
    lines.push(
      `  code     ${c.repo}${c.subdir ? `/${c.subdir}` : ""} @ ${c.commit?.slice(0, 12) ?? "(no commit)"}${c.dirty ? ` +${c.changedFiles.length} changed` : ""}`,
    );
    if (c.skippedSubmodules.length)
      lines.push(
        `  warning  submodule contents are not snapshotted: ${c.skippedSubmodules.join(", ")}`,
      );
  }
  lines.push(
    `  time     created ${r.createdAt}  ran ${runDuration(r)}  exit ${r.exitCode ?? "-"}  cleanup ${r.cleanup}`,
  );
  if (Object.keys(r.spec.params).length)
    lines.push(
      `  params   ${Object.entries(r.spec.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
  if (r.spec.agent)
    lines.push(
      `  agent    ${r.spec.agent.harness} ${r.spec.agent.sessionId ?? "(session unknown)"}`,
    );
  if (summary && Object.keys(summary).length) {
    lines.push(
      `  metrics  ${Object.entries(summary)
        .map(([k, v]) => `${k}=${fmtNum(v)}`)
        .join("  ")}`,
    );
  }
  if (r.note) lines.push(`  note     ${r.note.split("\n").join("\n           ")}`);
  return lines.join("\n");
}

export function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(3) : String(Number(v.toPrecision(5)));
}

/** One line per process holding memory: who, what, and for how long. Unknown parts are `?`. */
function processLine(p: GpuProcess, now: number): string {
  const started = p.startedAt ? Date.parse(p.startedAt) : null;
  const age = started !== null && Number.isFinite(started) ? duration(now - started) : "unknown";
  const where = p.runId ? `run ${p.runId}` : (p.container ?? "no container");
  return `      pid ${p.pid}  ${p.memMiB} MiB  ${p.user ?? "unknown"}  ${p.command ?? "unknown"}  ${where}  ${age}`;
}

function formatNode(r: NodeResources, leases: Lease[], head: string): string[] {
  const owner = new Map(leases.flatMap((x) => x.gpuIds.map((g) => [g, x.runId] as const)));
  const lines = [head];
  if (r.gpuError) lines.push(`gpus: unavailable (${r.gpuError})`);
  const now = Date.now();
  for (const g of r.gpus) {
    const run = owner.get(g.uuid);
    const state = run ? `run ${run}` : g.available ? "free" : "busy (external)";
    const util = g.utilPct === null ? "-" : `${g.utilPct}%`;
    lines.push(
      `  gpu${g.index} ${g.name}  ${g.memUsedMiB}/${g.memTotalMiB} MiB  util ${util.padStart(4)}  ${state}`,
    );
    for (const p of g.processes) lines.push(processLine(p, now));
  }
  for (const d of r.devices ?? []) {
    const held = leases
      .filter((l) => l.state === "active")
      .flatMap((l) =>
        l.roles.flatMap((role) =>
          (role.devices ?? [])
            .filter((x) => x.class === d.class)
            .map((x) => ({ ...x, runId: l.runId, role: role.role })),
        ),
      );
    const used = held.reduce((n, x) => n + x.count, 0);
    const free = d.exclusive && used ? 0 : Math.max(0, d.count - used);
    lines.push(
      `device  ${d.class}  ${free}/${d.count} free${d.exclusive ? " (exclusive)" : ""}${d.detail ? `  ${d.detail}` : ""}`,
    );
    for (const x of held)
      lines.push(
        `      run ${x.runId}  role ${x.role}  ${x.count} leased${x.paths.length ? `  ${x.paths.join(", ")}` : ""}`,
      );
  }
  const leasedCpu = leases.reduce((n, x) => n + x.cpus, 0);
  const leasedMem = leases.reduce((n, x) => n + x.memGB, 0);
  lines.push(
    `cpu     ${r.cpu.count} cores, ${leasedCpu} leased, ${r.cpu.busy} in use, load ${r.cpu.load1}`,
  );
  lines.push(
    `memory  ${r.memory.totalGB} GB, ${leasedMem} leased, ${r.memory.availableGB} available`,
  );
  lines.push(`disk    ${r.disk.freeGB}/${r.disk.totalGB} GB free (${r.disk.path})`);
  return lines;
}

export function formatLedger(l: Ledger): string {
  const lines = formatNode(l.resources, l.leases, `node ${l.resources.node}`);
  for (const n of l.nodes) {
    const state = n.online ? "online" : `offline${n.error ? ` (${n.error})` : ""}`;
    const head = `\nnode ${n.name}  ${n.url}  ${state}`;
    if (!n.info) {
      lines.push(head);
      continue;
    }
    lines.push(...formatNode(n.info.resources, n.info.leases, head));
    lines.push(`queue   ${n.info.queued} waiting there`);
    if (n.info.datasets.length) lines.push(`data    ${n.info.datasets.join(", ")}`);
  }
  lines.push(`${l.nodes.length ? "\n" : ""}queue   ${l.queued.length === 0 ? "empty" : ""}`);
  for (const q of l.queued) lines.push(`  ${q.runId}  ${q.reason ?? ""}`);
  return lines.join("\n");
}

export function formatDoctor(r: DoctorReport): string {
  return r.checks
    .map((c) => `${c.ok ? (c.warn ? "warn" : "ok  ") : "FAIL"} ${c.name.padEnd(11)} ${c.detail}`)
    .join("\n");
}

/** 1.2 GB, 340 MB, 12 KB */
export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Folders with totals over their subfolders, as an indented tree. */
export function formatFolders(fs: FolderStat[]): string {
  if (fs.length === 0) return "no folders; file runs with `orbit mv <id...> <folder>` or --folder";
  const paths = new Set<string>();
  for (const f of fs) {
    const parts = f.path.split("/");
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
  }
  const rows = [["FOLDER", "RUNS", "JOBS", "ACTIVE", "SIZE"]];
  for (const p of [...paths].sort()) {
    const sub = fs.filter((f) => inFolder(f.path, p));
    const sum = (k: "runs" | "jobs" | "active" | "sizeBytes") => sub.reduce((a, f) => a + f[k], 0);
    const depth = p.split("/").length - 1;
    rows.push([
      `${"  ".repeat(depth)}${p.split("/").at(-1)}/`,
      String(sum("runs")),
      String(sum("jobs")),
      String(sum("active")),
      fmtBytes(sum("sizeBytes")),
    ]);
  }
  return table(rows);
}

/** Measured use against the request, e.g. `memory 11.2/16 GB peak, CPU 3.1 peak 1.2 mean/4`. */
export function formatUsage(r: Run): string {
  const u = r.usage;
  if (!u) return "-";
  const res = r.spec.resources;
  const parts = [
    `memory ${u.peakMemGB}/${res.memGB} GB peak`,
    `CPU ${u.peakCpus} peak ${u.meanCpus} mean/${res.cpus}`,
  ];
  if (u.peakGpuMemGB !== null) parts.push(`GPU memory ${u.peakGpuMemGB} GB peak`);
  if (u.oomKilled) parts.push("OUT OF MEMORY");
  else if (u.oomKills) parts.push(`${u.oomKills} killed for memory`);
  return parts.join(", ");
}

export const compactTable = (rows: string[][]): string => table(rows, true);
