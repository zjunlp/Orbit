import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuthStore } from "../auth/index.ts";
import { type OrbitPaths, type RunDirs, runDirs } from "../config/paths.ts";
import type { AtifSource, AtifTrajectory } from "../contracts/index.ts";
import {
  type AfterStatus,
  type AuthTestResult,
  type DoctorCheck,
  type DoctorReport,
  Folder,
  isTerminal,
  type Lease,
  leaseRequest,
  type NodeResources,
  type RemoteSubmit,
  type RoleAllocation,
  type Run,
  type RunDeletion,
  type RunEvent,
  RunResume,
  type RunResumeInput,
  RunSpec,
  type RunSpecInput,
  type RunState,
  roleRequests,
  type ServiceSpec,
} from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import type { Prepared } from "../harness/index.ts";
import { type AgentRegistry, builtinRegistry } from "../harness/registry.ts";
import { newId, nowIso } from "../lib/ids.ts";
import { Redactor } from "../lib/redact.ts";
import { allocateRoles, hostProtection } from "../resources/allocate.ts";
import { resolveAgentRef } from "../sessions/index.ts";
import { trajectoryTokens } from "../sessions/tokens.ts";
import { redactTrajectory, trajectorySummary } from "../sessions/trajectory.ts";
import type { RunFilter, Store } from "../store/index.ts";
import type { DatasetRegistry } from "../workspace/datasets.ts";
import { snapshotProject } from "../workspace/snapshot.ts";
import * as checkpoint from "./checkpoint.ts";
import * as cleanup from "./cleanup.ts";
import type { RunContext } from "./context.ts";
import { NotFoundError, UserError } from "./errors.ts";
import { type Control, containerName, DOCKER_RETRY_MS } from "./execution.ts";
import * as launch from "./launch.ts";
import * as phases from "./phases.ts";
import { keepsContainer } from "./phases.ts";
import {
  joinReasons,
  nodeLeases,
  type RemoteNode,
  type RemotePlacement,
  remoteBlocker,
} from "./placement.ts";
import * as preflight from "./preflight.ts";
import { SECRET_NAME } from "./process.ts";
import * as processBackend from "./process-backend.ts";
import { type ReconcileResult, reconcile as reconcileRuns } from "./reconcile.ts";
import * as remoteRuns from "./remote.ts";
import * as sampling from "./sampling.ts";
import * as services from "./services.ts";
import { runTrajectory } from "./trajectory.ts";
import type { Targets, UsageSampler } from "./usage.ts";
import * as watch from "./watch.ts";

export { NotFoundError, UserError } from "./errors.ts";
export { installBundle } from "./launch.ts";

export interface RunServiceDeps {
  store: Store;
  paths: OrbitPaths;
  probe: () => Promise<NodeResources>;
  /** Credential profiles for `spec.auth`; runs with auth are rejected without it. */
  auth?: AuthStore;
  /** Agent definitions known on this node; runs with auth need one for the profile's harness. */
  agents?: AgentRegistry;
  /** Named datasets on this node, for `dataset` mounts. */
  datasets?: DatasetRegistry;
  /** Scheduler period; the loop also runs after every submit/finish. */
  tickMs?: number;
  /** Period of reconciling Docker resources and leases with the ledger (default 10 min; 0 disables). */
  reconcileMs?: number;
  /**
   * Runs that may be starting (pulling, building, creating containers and services) at once on this
   * node; more wait (default `ORBIT_MAX_STARTING` or 4). Heavy environments unpack images and VMs.
   */
  maxStarting?: number;
  /**
   * Command prefix that runs this orbit binary (`node [execArgv] <entry>`); process runs get a
   * `docker` shim calling `<prefix> __docker-shim`. Without it process runs are rejected.
   */
  shim?: string[];
  /** Resource sampling period of running runs (default 5 s). */
  usageMs?: number;
}

export interface RunChange {
  run: Run;
  event?: RunEvent;
}

const PROBE_TTL_MS = 2000;
/** Group of the runs created by `testAuth`. */
export const AUTH_TEST_GROUP = "auth-test";

/**
 * The single owner of Run state on this node: submission, queueing, leases, container lifecycle,
 * evidence collection and cleanup. Emits "change" for every persisted update.
 */
export class RunService extends EventEmitter<{ change: [RunChange]; deleted: [string[]] }> {
  private readonly store: Store;
  private readonly paths: OrbitPaths;
  private readonly probeFn: () => Promise<NodeResources>;
  /** Agent definitions; built-ins when the caller (tests, embedders) did not supply a registry. */
  private readonly agents: AgentRegistry;
  private readonly homeLabel: string;
  private readonly node: string;
  /** Worker nodes; set by the daemon when the cluster module starts. */
  private remote: RemotePlacement | null = null;
  /** `<run>@<node>` pairs whose node refused the run: not placed there again for a while. */
  private readonly refused = new Map<string, { why: string; until: number }>();
  /** Stops requested for local runs not watched yet (see `control`). */
  private readonly stopIntent = new Map<string, "cancel" | "timeout">();
  /** Resource samplers of the runs this node executes. */
  private readonly samplers = new Map<string, UsageSampler>();
  /** Runs from a primary still being received (see `submitRemote`). */
  private readonly receiving = new Map<string, Promise<Run>>();
  private readonly gpuMode = docker.gpuModeProbe();
  private cached: { at: number; value: NodeResources } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling: Promise<ReconcileResult> | null = null;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  private stopped = false;
  /** Runs with an active launch/watch task in this process. */
  private readonly active = new Map<string, Control>();
  private readonly restoring = new Map<string, number>();
  private readonly deleting = new Set<string>();
  private readonly trajectoryJobs = new Map<string, Promise<AtifTrajectory | null>>();

  private readonly deps: RunServiceDeps;

  private readonly context: RunContext;

  constructor(deps: RunServiceDeps) {
    super();
    this.setMaxListeners(20);
    const service = this;
    this.context = {
      get active() {
        return service.active;
      },
      armTimeout: (run) => this.armTimeout(run),
      buildFile: (run, dirs) => this.buildFile(run, dirs),
      bundleTag: (df, name) => this.bundleTag(df, name),
      get cgroupDirs() {
        return service.cgroupDirs;
      },
      changed: (run, event) => this.changed(run, event),
      cleanup: (run) => this.cleanup(run),
      trajectory: (id, finalized) => this.trajectory(id, false, finalized),
      cleanupProcess: (run) => this.cleanupProcess(run),
      cleanupServices: (run) => this.cleanupServices(run),
      captureCheckpoint: (id, containerId, executionMin) =>
        checkpoint.capture(this.context, id, containerId, executionMin),
      collect: (run, containerId) => this.collect(run, containerId),
      containerCgroups: (ids) => this.containerCgroups(ids),
      containerSpec: (run, dirs, image) => this.containerSpec(run, dirs, image),
      control: (id) => this.control(id),
      get deps() {
        return service.deps;
      },
      dirs: (id) => this.dirs(id),
      disarmTimeout: (id) => this.disarmTimeout(id),
      dispatchRemote: (id) => this.dispatchRemote(id),
      ensureImage: (run, dirs) => this.ensureImage(run, dirs),
      envFile: (id) => this.envFile(id),
      finalize: (run, state, exitCode, reason) => this.finalize(run, state, exitCode, reason),
      finishAuth: (run) => this.finishAuth(run),
      get gpuMode() {
        return service.gpuMode();
      },
      get homeLabel() {
        return service.homeLabel;
      },
      launchProcess: (run, dirs, ctl) => this.launchProcess(run, dirs, ctl),
      localBlocker: (spec) => this.localBlocker(spec),
      loseRemote: (id, why) => this.loseRemote(id, why),
      measure: (id) => this.measure(id),
      mirrors: () => this.mirrors(),
      mustGet: (id) => this.mustGet(id),
      networkNames: (run) => this.networkNames(run),
      get node() {
        return service.node;
      },
      passEnv: (run) => this.passEnv(run),
      get paths() {
        return service.paths;
      },
      prepareAuth: (run, dirs) => this.prepareAuth(run, dirs),
      receiveRemote: (input) => this.receiveRemote(input),
      get receiving() {
        return service.receiving;
      },
      redactLog: (run) => this.redactLog(run),
      redactor: (run) => this.redactor(run),
      get refused() {
        return service.refused;
      },
      get remote() {
        return service.remote;
      },
      remoteNodes: () => this.remoteNodes(),
      requeueRemote: (id, why) => this.requeueRemote(id, why),
      resources: (force) => this.resources(force),
      runAfter: (id, containerId, ctl) => this.runAfter(id, containerId, ctl),
      runHooks: (id, containerId, which) => this.runHooks(id, containerId, which),
      get samplers() {
        return service.samplers;
      },
      save: (run, kind, message) => this.save(run, kind, message),
      serviceContainer: (run, s, image) => this.serviceContainer(run, s, image),
      serviceImage: (run, dirs, s) => this.serviceImage(run, dirs, s),
      setAfter: (id, status, message) => this.setAfter(id, status, message),
      skipAfter: (id, why) => this.skipAfter(id, why),
      specError: (spec) => this.specError(spec),
      startCheck: (spec, here, candidates) => this.startCheck(spec, here, candidates),
      startServices: (id, dirs, ctl) => this.startServices(id, dirs, ctl),
      startUsage: (id, targets) => this.startUsage(id, targets),
      stopProcess: (run) => this.stopProcess(run),
      stopServices: (id) => this.stopServices(id),
      stopUsage: (run, oomKilled) => this.stopUsage(run, oomKilled),
      get stopped() {
        return service.stopped;
      },
      get store() {
        return service.store;
      },
      tick: () => this.tick(),
      waitMain: (id, containerId) => this.waitMain(id, containerId),
      waitServices: (id, names, ctl) => this.waitServices(id, names, ctl),
      waitStopped: (containerId) => this.waitStopped(containerId),
      watch: (id, containerId, recovered) => this.watch(id, containerId, recovered),
      watchProcess: (id, exited) => this.watchProcess(id, exited),
    };
    this.deps = deps;
    this.store = deps.store;
    this.paths = deps.paths;
    this.probeFn = deps.probe;
    this.agents = deps.agents ?? builtinRegistry();
    this.node = deps.paths.node;
    this.homeLabel = createHash("sha256")
      .update(resolve(deps.paths.home))
      .digest("hex")
      .slice(0, 12);
  }

  // ---- public API ----

  async start(): Promise<void> {
    await this.recover();
    void this.measureMissing();
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 3000);
    void this.tick();
    const every = this.deps.reconcileMs ?? 600_000;
    if (every > 0) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), every);
      this.reconcileTimer.unref();
      // A first round soon after start: leftovers of a crash are found without waiting a period.
      setTimeout(
        () => void (this.stopped ? null : this.reconcile()),
        Math.min(every, 60_000),
      ).unref();
    }
  }

  /** One reconciliation round (at most one at a time); see `runs/reconcile.ts`. */
  reconcile(): Promise<ReconcileResult> {
    this.reconciling ??= reconcileRuns(this.context)
      .then((r) => {
        if (r.removed.length || r.released.length || r.failed.length)
          console.error(
            `orbit reconcile: removed ${r.removed.length}, released ${r.released.length} lease(s)${r.failed.length ? `, ${r.failed.length} removal(s) failed` : ""}`,
          );
        return r;
      })
      .finally(() => {
        this.reconciling = null;
      });
    return this.reconciling;
  }

  /** This node's name in the cluster. */
  get nodeName(): string {
    return this.node;
  }

  setRemote(remote: RemotePlacement | null): void {
    this.remote = remote;
  }

  private remoteNodes(): RemoteNode[] {
    return remoteRuns.remoteNodes(this.context);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    await this.ticking;
    await this.reconciling?.catch(() => null);
    for (const a of this.active.values()) {
      a.logs?.kill();
      clearTimeout(a.timeout);
    }
    for (const u of this.samplers.values()) u.halt();
  }

  async resources(force = false): Promise<NodeResources> {
    if (!force && this.cached && Date.now() - this.cached.at < PROBE_TTL_MS)
      return this.cached.value;
    const value = await this.probeFn();
    this.cached = { at: Date.now(), value };
    return value;
  }

  get(id: string): Run | null {
    return this.store.getRun(id);
  }

  /**
   * Why a run cannot be deleted, or null. Only finished runs whose cleanup is confirmed (and, for a
   * mirror of a remote run, whose mirroring is over); runs of a bench trial go with their job.
   */
  deleteBlocker(run: Run, forJob = false): string | null {
    if (this.deleting.has(run.id)) return `${run.id}: deletion is in progress`;
    if (this.trajectoryJobs.has(run.id)) return `${run.id}: trajectory is being generated`;
    if (this.restoring.has(run.id)) return `${run.id}: checkpoint is being restored`;
    if (!isTerminal(run.state))
      return `${run.id} is ${run.state}; cancel it and wait for it to end`;
    if (
      run.checkpoint?.imageId &&
      this.store
        .listRuns({ states: ["queued", "starting", "running"], limit: 10_000 })
        .some((r) => r.spec.image === run.checkpoint?.imageId)
    )
      return `${run.id}: checkpoint is used by an active restored run`;
    if (run.cleanup !== "done")
      return `${run.id}: cleanup is ${run.cleanup}; its container or processes may still exist`;
    if (this.active.has(run.id)) return `${run.id} is still being finalized`;
    if (run.remote && this.store.getSync(run.id)?.done === false)
      return `${run.id} is still being mirrored from ${run.node}`;
    if (!forJob) {
      const t = this.store.trialsByRun(run.id)[0];
      if (t) return `${run.id} belongs to bench job ${t.jobId}; delete the job instead`;
    }
    return null;
  }

  /**
   * Delete finished runs: their records, events and leases, and their directory (logs, outputs,
   * code snapshot, Agent home). All are checked before anything is removed. Irreversible.
   */
  async delete(ids: string[], opts: { forJob?: boolean } = {}): Promise<RunDeletion> {
    const unique = [...new Set(ids)];
    const runs = unique.map((id) => {
      const r = this.store.getRun(id);
      if (!r) throw new NotFoundError(`run not found: ${id}`);
      return r;
    });
    const blocked = runs.map((r) => this.deleteBlocker(r, opts.forJob)).filter(Boolean);
    if (blocked.length) throw new UserError(blocked.join("; "));
    for (const id of unique) this.deleting.add(id);
    try {
      for (const r of runs) {
        if (
          r.checkpoint?.imageId &&
          !(await docker.removeCheckpoint(checkpoint.checkpointTag(r.id)))
        )
          throw new UserError(`${r.id}: checkpoint image removal failed; run records retained`);
      }
      this.store.deleteRuns(unique);
      const leftovers: string[] = [];
      for (const r of runs) if (!(await this.removeDir(r))) leftovers.push(this.dirs(r.id).root);
      this.emit("deleted", unique);
      return { deleted: unique, leftovers };
    } finally {
      for (const id of unique) this.deleting.delete(id);
    }
  }

  /** Remove a run directory; files a container wrote as root are removed from a container. */
  private async removeDir(run: Run): Promise<boolean> {
    return cleanup.removeDir(this.context, run);
  }

  storeList(filter: RunFilter): Run[] {
    return this.store.listRuns(filter);
  }

  events(id: string, afterSeq = 0): RunEvent[] {
    return this.store.events(id, afterSeq);
  }

  async submit(
    input: RunSpecInput,
    opts: { folder?: string; restoreFrom?: Run } = {},
  ): Promise<Run> {
    const spec = RunSpec.parse(input);
    const folder = Folder.safeParse(opts.folder ?? "");
    if (!folder.success) throw new UserError(folder.error.issues[0]?.message ?? "invalid folder");
    const failed = (await this.preflight(spec)).find((c) => !c.ok);
    if (failed) throw new UserError(failed.detail);
    if (spec.agent) spec.agent = await resolveAgentRef(spec.agent);

    const id = newId();
    const dirs = runDirs(this.paths, id);
    mkdirSync(dirs.output, { recursive: true });
    writeFileSync(dirs.metrics, "");
    writeFileSync(dirs.log, "");
    let code: Run["code"] = null;
    if (spec.project && spec.snapshot) {
      try {
        code = await snapshotProject(spec.project, dirs.workspace, dirs.diff);
      } catch (e) {
        rmSync(dirs.root, { recursive: true, force: true });
        throw new UserError(`snapshot failed: ${(e as Error).message}`);
      }
    }
    const run: Run = {
      id,
      spec,
      state: "queued",
      reason: null,
      exitCode: null,
      node: this.node,
      image: spec.image ?? null,
      containerId: null,
      lease: null,
      code,
      proc: null,
      cleanup: "pending",
      checkpoint: null,
      remote: false,
      origin: null,
      imageId: null,
      note: "",
      folder: folder.data,
      usage: null,
      trajectory: null,
      tokens: null,
      services: [],
      after: null,
      phases: [],
      stopRequested: null,
      sizeBytes: null,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
    };
    if (opts.restoreFrom) {
      try {
        await checkpoint.restore(this.context, opts.restoreFrom, run);
      } catch (e) {
        rmSync(dirs.root, { recursive: true, force: true });
        throw new UserError(`checkpoint restore failed: ${(e as Error).message}`);
      }
    }
    this.save(
      run,
      "submitted",
      code
        ? `snapshot ${code.commit?.slice(0, 8) ?? "(no commit)"}${code.dirty ? " +dirty" : ""}, ${code.fileCount} files`
        : "no snapshot",
    );
    if (code?.skippedSubmodules.length) {
      const event = this.store.addEvent(
        run.id,
        "warning",
        `submodule contents are not snapshotted: ${code.skippedSubmodules.join(", ")}`,
      );
      this.changed(run, event);
    }
    void this.tick();
    return run;
  }

  async resume(id: string, input: RunResumeInput = {}): Promise<Run> {
    const run = this.mustGet(id);
    if (
      this.deleting.has(id) ||
      run.remote ||
      run.origin ||
      !isTerminal(run.state) ||
      run.cleanup !== "done" ||
      this.active.has(id)
    )
      throw new UserError("resume requires a local finished run with confirmed cleanup");
    const { command } = RunResume.parse(input);
    const spec = checkpoint.resumeSpec(run, command, this.agents);
    this.restoring.set(id, (this.restoring.get(id) ?? 0) + 1);
    try {
      if (!(await docker.imageExists(spec.image as string)))
        throw new UserError("checkpoint image is no longer available on this node");
      return await this.submit(spec, { folder: run.folder, restoreFrom: run });
    } finally {
      const remaining = (this.restoring.get(id) ?? 1) - 1;
      if (remaining) this.restoring.set(id, remaining);
      else this.restoring.delete(id);
    }
  }

  async cancel(id: string): Promise<Run> {
    const run = this.mustGet(id);
    if (isTerminal(run.state)) return run;
    if (run.state === "queued") {
      return this.finalize(run, "cancelled", null, "cancelled while queued");
    }
    if (run.remote) {
      const sync = this.store.getSync(id);
      if (sync) this.store.putSync({ ...sync, cancel: true });
      const event = this.store.addEvent(id, "cancel", `cancel requested on ${run.node}`);
      this.changed(run, event);
      void this.remote?.cancel(run).catch(() => {});
      return this.mustGet(id);
    }
    this.requestStop(run, "cancel");
    return this.mustGet(id);
  }

  /** Resolves with the run once it is terminal and cleaned up (or failed to clean up). */
  waitDone(id: string): Promise<Run> {
    const settled = (r: Run) => isTerminal(r.state) && r.cleanup !== "pending";
    const now = this.mustGet(id);
    if (settled(now)) return Promise.resolve(now);
    return new Promise((resolve) => {
      const onChange = ({ run }: RunChange) => {
        if (run.id !== id || !settled(run)) return;
        this.off("change", onChange);
        resolve(run);
      };
      this.on("change", onChange);
    });
  }

  /**
   * Check a profile end to end: a small real run asks the Agent for a fixed answer. The answer is not in
   * the prompt, so finding it in the log means the model replied.
   */
  async testAuth(name: string, image = "python:3.12-slim"): Promise<AuthTestResult> {
    const entry = this.deps.auth?.get(name);
    if (!entry) throw new NotFoundError(`auth profile not found: ${name}`);
    const prompt =
      "Reply with the word ORBIT_AUTH immediately followed by _OK, as one token, and nothing else.";
    const command =
      entry.profile.harness === "codex"
        ? [
            "codex",
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            prompt,
          ]
        : ["claude", "-p", "--dangerously-skip-permissions", prompt];
    const run = await this.submit({
      name: `auth-test ${name}`,
      group: AUTH_TEST_GROUP,
      image,
      command,
      auth: name,
      snapshot: false,
      resources: { gpus: 0, cpus: 1, memGB: 2, node: this.node },
      timeoutMin: 5,
      tags: { auth: name },
    });
    const done = await this.waitDone(run.id);
    const log = readFileSync(this.dirs(run.id).log, "utf8");
    const ok = done.state === "succeeded" && log.includes("ORBIT_AUTH_OK");
    const tail = log.trim().split("\n").slice(-5).join("\n");
    return {
      ok,
      runId: run.id,
      detail: ok
        ? "agent replied ORBIT_AUTH_OK"
        : `${done.state}: ${done.reason ?? ""}\n${tail}`.trim(),
    };
  }

  /** File runs in a folder (`""` for none); returns the runs that changed. */
  setFolder(ids: string[], folder: string): Run[] {
    const runs = ids.map((id) => this.mustGet(id));
    const changed = runs.filter((r) => r.folder !== folder);
    for (const r of changed) {
      r.folder = folder;
      this.save(r, "folder", folder || "(none)");
    }
    return changed;
  }

  setNote(id: string, note: string): Run {
    const run = this.mustGet(id);
    run.note = note;
    this.save(run, "note", note.length > 200 ? `${note.slice(0, 200)}…` : note);
    return run;
  }

  ledger(): { leases: Lease[]; queued: { runId: string; reason: string | null }[] } {
    return {
      leases: this.store.activeLeases(),
      queued: this.store.queuedRuns().map((r) => ({ runId: r.id, reason: r.reason })),
    };
  }

  dirs(id: string): RunDirs {
    return runDirs(this.paths, id);
  }

  // ---- scheduling ----

  /** Run one scheduling pass; concurrent calls coalesce into at most one extra pass. */
  tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.schedule();
          await this.retryCleanup();
        } while (this.tickAgain);
      } catch (e) {
        console.error("orbit scheduler:", e);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  /**
   * Check a run before submitting it: the same validation as `submit`, plus (as `full`) whether the
   * image and datasets are there, the output disk has room, and where and when it would start.
   */
  async check(input: RunSpecInput): Promise<DoctorReport> {
    const checks = await this.preflight(RunSpec.parse(input), true);
    return { ok: checks.every((c) => c.ok), checks };
  }

  /** Why `spec` is invalid on this daemon, or null. Resolves `spec.dockerfile` and host networking. */
  private specError(spec: RunSpec): string | null {
    return preflight.specError(this.context, spec);
  }

  private async preflight(spec: RunSpec, full = false): Promise<DoctorCheck[]> {
    return preflight.preflight(this.context, spec, full);
  }

  /** Where the run would start if submitted now (runs already queued may go first). */
  private async startCheck(
    spec: RunSpec,
    here: boolean,
    candidates: RemoteNode[],
  ): Promise<DoctorCheck> {
    return preflight.startCheck(this.context, spec, here, candidates);
  }

  /** Why `spec` can never run on this node as configured now, or null. */
  private async localBlocker(spec: RunSpec): Promise<string | null> {
    return preflight.localBlocker(this.context, spec);
  }

  /**
   * Place queued runs: on this node when it can run them now, else on the first worker node (by
   * name) that can. Runs received from a primary stay here.
   */
  private async schedule(): Promise<void> {
    const queued = this.store.queuedRuns();
    if (queued.length === 0) return;
    // A copy: memory granted in this pass is taken off what the probe saw as available.
    const res = structuredClone(await this.resources(true));
    const nodes = this.remoteNodes();
    const mirrors = nodes.length ? this.mirrors() : [];
    let starting = this.store
      .listRuns({ states: ["starting"], limit: 10_000 })
      .filter((r) => !r.remote).length;
    for (const q of queued) {
      const reasons: [string, string][] = [];
      const blocked =
        hostProtection(res, starting, this.maxStarting) ?? (await this.localBlocker(q.spec));
      // Re-read after the awaits: a cancel may have ended the run meanwhile. No await from here on
      // until it is leased, placed or its reason saved.
      const run = this.store.getRun(q.id);
      if (run?.state !== "queued") continue;
      if (blocked) reasons.push([this.node, blocked]);
      else {
        const a = allocateRoles(roleRequests(run.spec), res, this.store.activeLeases());
        if (a.ok) {
          this.leaseLocal(run, a.roles);
          res.memory.availableGB -= leaseRequest(run.spec).memGB;
          starting++;
          continue;
        }
        reasons.push([this.node, a.reason]);
      }
      let placed = false;
      for (const n of run.origin ? [] : nodes) {
        const why =
          this.refusal(`${run.id}@${n.name}`) ??
          remoteBlocker(run.spec, n) ??
          (n.online ? null : "offline");
        if (why) {
          reasons.push([n.name, why]);
          continue;
        }
        const a = allocateRoles(
          roleRequests(run.spec),
          n.resources as NodeResources,
          nodeLeases(n, mirrors),
        );
        if (!a.ok) {
          reasons.push([n.name, a.reason]);
          continue;
        }
        mirrors.push(this.placeRemote(run, n.name, a.roles));
        placed = true;
        break;
      }
      if (placed) continue;
      const reason = joinReasons(reasons);
      if (run.reason !== reason) {
        run.reason = reason;
        this.save(run);
      }
    }
  }

  private get maxStarting(): number {
    const env = Number(process.env.ORBIT_MAX_STARTING);
    return this.deps.maxStarting ?? (Number.isInteger(env) && env > 0 ? env : 4);
  }

  private refusal(key: string): string | null {
    return remoteRuns.refusal(this.context, key);
  }

  private leaseLocal(run: Run, roles: RoleAllocation[]): void {
    const gpuIds = roles.flatMap((x) => x.gpuIds);
    const lease: Lease = {
      id: `lease-${run.id}`,
      runId: run.id,
      node: this.node,
      gpuIds,
      roles,
      cpus: leaseRequest(run.spec).cpus,
      memGB: leaseRequest(run.spec).memGB,
      state: "active",
      createdAt: nowIso(),
      releasedAt: null,
    };
    run.lease = lease;
    run.state = "starting";
    run.reason = null;
    this.store.tx(() => {
      this.store.putLease(lease);
      this.save(run, "leased", gpuIds.length ? `GPUs ${gpuIds.join(", ")}` : "no GPUs");
    });
    void this.launch(run.id).catch((e) =>
      console.error(`orbit: run ${run.id}:`, (e as Error).message),
    );
  }

  // ---- runs on other nodes (primary side) ----

  /** Non-terminal runs this node placed on workers. */
  private mirrors(): Run[] {
    return remoteRuns.mirrors(this.context);
  }

  /**
   * Mark the run as placed on `node` with a predicted lease (kept in the run record only; it counts
   * against that node until the node reports its own lease) and send it.
   */
  private placeRemote(run: Run, node: string, roles: RoleAllocation[]): Run {
    return remoteRuns.placeRemote(this.context, run, node, roles);
  }

  private async dispatchRemote(id: string): Promise<void> {
    return remoteRuns.dispatchRemote(this.context, id);
  }

  /** The run never started on its node: queue it here again (or finish a requested cancel). */
  requeueRemote(id: string, why: string): void {
    remoteRuns.requeueRemote(this.context, id, why);
  }

  /** The node no longer knows a run it had accepted, or the node was removed. */
  loseRemote(id: string, why: string): void {
    remoteRuns.loseRemote(this.context, id, why);
  }

  /**
   * Mirror the worker's record of a run: its new events (with their original times), state, outcome,
   * container and cleanup. Emits "change" per event so notifications and benchmarks see the
   * terminal event as for a local run.
   */
  applyRemote(id: string, remote: Run, events: RunEvent[]): Run {
    return remoteRuns.applyRemote(this.context, id, remote, events);
  }

  // ---- runs from a primary (worker side) ----

  /**
   * Accept a run placed here by another node. Idempotent by id. Its code arrives as bundles already
   * stored under `cache/bundles`; secrets, datasets and auth come from this node's own configuration.
   */
  submitRemote(input: RemoteSubmit): Promise<Run> {
    return remoteRuns.submitRemote(this.context, input);
  }

  private async receiveRemote(input: RemoteSubmit): Promise<Run> {
    return remoteRuns.receiveRemote(this.context, input);
  }

  private async launch(id: string): Promise<void> {
    return launch.launch(this.context, id);
  }

  private envFile(id: string): string {
    return launch.envFile(this.context, id);
  }

  /** `spec.passEnv` values from the daemon environment; missing variables are skipped. */
  private passEnv(run: Run): Record<string, string> {
    return launch.passEnv(this.context, run);
  }

  /** Stop the run when its timeout is reached (from `startedAt`, so also after a restart). */
  private armTimeout(run: Run): void {
    if (
      !run.spec.timeoutMin ||
      this.stopped ||
      run.exitCode !== null ||
      phases.readCode(join(this.dirs(run.id).orbit, "phases", "main.exit")) !== null
    )
      return;
    this.disarmTimeout(run.id);
    const ctl = this.control(run.id);
    const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
    const left = Math.max(0, started + run.spec.timeoutMin * 60_000 - Date.now());
    const t = setTimeout(() => {
      const now = this.store.getRun(run.id);
      if (now && !isTerminal(now.state)) this.requestStop(now, "timeout");
    }, left);
    ctl.timeout = t;
    t.unref();
  }

  private disarmTimeout(id: string): void {
    const ctl = this.active.get(id);
    if (!ctl) return;
    clearTimeout(ctl.timeout);
    ctl.timeout = undefined;
  }

  /** A run's networks: `default` (internal when the run has no network) plus declared ones. */
  private networkNames(run: Run): { short: string; name: string; internal: boolean }[] {
    return services.networkNames(this.context, run);
  }

  /**
   * Build or pull the service images, create the run's networks, then start the services in
   * dependency order, each once its dependencies are ready, and wait for the run's own dependencies.
   * Throws on any failure; `cleanup` removes whatever was created.
   */
  private async startServices(id: string, dirs: RunDirs, ctl: Control): Promise<void> {
    return services.startServices(this.context, id, dirs, ctl);
  }

  /** Wait until each service is healthy (with a health check) or running (without one). */
  private async waitServices(id: string, names: string[], ctl: Control): Promise<void> {
    return services.waitServices(this.context, id, names, ctl);
  }

  private async serviceImage(run: Run, dirs: RunDirs, s: ServiceSpec): Promise<string> {
    return services.serviceImage(this.context, run, dirs, s);
  }

  private serviceContainer(run: Run, s: ServiceSpec, image: string): docker.ContainerSpec {
    return services.serviceContainer(this.context, run, s, image);
  }

  /**
   * After the run's container stopped: note services that broke during the run, stop them, then
   * keep their logs and `collect` paths in `output/services/<name>/`.
   */
  private async stopServices(id: string): Promise<void> {
    return services.stopServices(this.context, id);
  }

  /** Copy `spec.collect` paths out of the stopped container into `output/collected/`. */
  private async collect(run: Run, containerId: string): Promise<void> {
    return watch.collect(this.context, run, containerId);
  }

  // ---- process backend ----

  private async launchProcess(run: Run, dirs: RunDirs, ctl: Control): Promise<void> {
    return processBackend.launchProcess(this.context, run, dirs, ctl);
  }

  /** Wait for the process (via its exit event, or by polling after a restart), then finalize. */
  private async watchProcess(id: string, exited: Promise<number | null> | null): Promise<void> {
    return processBackend.watchProcess(this.context, id, exited);
  }

  /** The run's control entry, taking over a stop requested before it existed (e.g. at recovery). */
  private control(id: string): Control {
    const ctl = this.active.get(id) ?? {};
    ctl.cancel ??= this.stopIntent.get(id);
    this.stopIntent.delete(id);
    this.active.set(id, ctl);
    return ctl;
  }

  /** SIGTERM the process group and stop its child containers; SIGKILL after a grace period. */
  private async stopProcess(run: Run): Promise<void> {
    return processBackend.stopProcess(this.context, run);
  }

  /** True when no process of the group and no child container is left. */
  private async cleanupProcess(run: Run): Promise<boolean> {
    return processBackend.cleanupProcess(this.context, run);
  }

  /** Remove a run's service containers, then its networks; true once all are gone. */
  private async cleanupServices(run: Run): Promise<boolean> {
    return services.cleanupServices(this.context, run);
  }

  private async recoverProcess(run: Run): Promise<void> {
    return processBackend.recoverProcess(this.context, run);
  }

  /** Process output goes straight to the log file; redact known secrets once it is complete. */
  private async redactLog(run: Run): Promise<void> {
    return processBackend.redactLog(this.context, run);
  }

  /** Agent CLI + credentials for `spec.auth`; the secret variables go through a private env file. */
  private async prepareAuth(run: Run, dirs: RunDirs): Promise<Prepared> {
    return launch.prepareAuth(this.context, run, dirs);
  }

  private async ensureImage(run: Run, dirs: RunDirs): Promise<string> {
    return launch.ensureImage(this.context, run, dirs);
  }

  /**
   * The Dockerfile to build: a Dockerfile inside the snapshotted repository is taken from the snapshot,
   * with the snapshot as its context, so the image matches the code the run was submitted with (as
   * on a worker). Outside the repository, or not in the snapshot (gitignored), the original is used.
   */
  private buildFile(run: Run, dirs: RunDirs): string {
    return launch.buildFile(this.context, run, dirs);
  }

  /** A Dockerfile inside a received bundle: the bundle hash already names its whole context. */
  private bundleTag(df: string, name: string): string | null {
    return launch.bundleTag(this.context, df, name);
  }

  private containerSpec(run: Run, dirs: RunDirs, image: string): docker.ContainerSpec {
    return launch.containerSpec(this.context, run, dirs, image);
  }

  /** Follow logs and wait for exit, then collect and clean up. */
  private async watch(id: string, containerId: string, recovered: boolean): Promise<void> {
    return watch.watch(this.context, id, containerId, recovered);
  }

  /** Exit code once the container has stopped (`docker wait`, retried while docker is unavailable). */
  private async waitStopped(containerId: string): Promise<number> {
    return watch.waitStopped(this.context, containerId);
  }

  /**
   * A run with an after phase: wait for the command's exit code (written by the phase script), or
   * for the container to stop first (killed, out of memory, cancelled).
   */
  private async waitMain(
    id: string,
    containerId: string,
  ): Promise<{ exitCode: number; running: boolean }> {
    return phases.waitMain(this.context, id, containerId);
  }

  /** Stop the command of a run with an after phase (its whole session), keeping the container. */
  private async stopMain(containerId: string): Promise<void> {
    return phases.stopMain(this.context, containerId);
  }

  /** `spec.hooks`, in order, each in its container with its time limit; failures are noted only. */
  private async runHooks(id: string, containerId: string, which: "main" | "services") {
    return phases.runHooks(this.context, id, containerId, which);
  }

  private setAfter(id: string, status: AfterStatus, message: string): void {
    phases.setAfter(this.context, id, status, message);
  }

  private skipAfter(id: string, why: string): void {
    phases.skipAfter(this.context, id, why);
  }

  /**
   * The after phase: copy its files in, switch the network if asked, run it detached (it writes
   * its output and exit code under /orbit/phases, so it survives a daemon restart), wait up to its
   * timeout, then keep its `collect` paths in `output/after/` (its output joins the run log later).
   */
  private async runAfter(id: string, containerId: string, ctl: Control): Promise<void> {
    return phases.runAfter(this.context, id, containerId, ctl);
  }

  private requestStop(run: Run, why: "cancel" | "timeout"): void {
    run.stopRequested = why === "cancel" ? why : (run.stopRequested ?? why);
    this.save(run);
    const ctl = this.active.get(run.id);
    if (ctl) ctl.cancel = run.stopRequested;
    // Not watched yet (the daemon is still reattaching): the watcher takes it over.
    else this.stopIntent.set(run.id, why);
    this.store.addEvent(run.id, why, why === "cancel" ? "cancel requested" : "timeout reached");
    // At its timeout, a run with an after phase stops only the command; the phase still runs.
    if (run.containerId && keepsContainer(run.spec)) {
      if (run.exitCode === null) void this.stopMain(run.containerId);
    } else if (run.containerId) void docker.stopContainer(run.containerId);
    if (run.proc) void this.stopProcess(run);
  }

  /** Terminal transition: record the outcome, remove the container, release the lease. */
  private async finalize(
    run: Run,
    state: RunState,
    exitCode: number | null,
    reason: string | null,
  ): Promise<Run> {
    return cleanup.finalize(this.context, run, state, exitCode, reason);
  }

  async trajectory(
    id: string,
    rebuild = false,
    finalized = false,
    source?: AtifSource,
  ): Promise<AtifTrajectory | null> {
    const run = this.mustGet(id);
    if (run.remote) throw new UserError("trajectory belongs to the executing node");
    if (this.deleting.has(id)) throw new UserError("run is being deleted");
    if (rebuild && (!isTerminal(run.state) || run.cleanup !== "done"))
      throw new UserError("trajectory rebuild requires a finished run with confirmed cleanup");
    if (source && !rebuild)
      throw new UserError("an explicit ATIF import requires rebuilding a finished run");
    const pending = this.trajectoryJobs.get(id);
    if (pending) {
      await pending.catch(() => null);
      if (!rebuild && !finalized) return pending;
      return this.trajectory(id, rebuild, finalized, source);
    }
    const work = runTrajectory(this.context, id, rebuild, finalized, source)
      .then((value) =>
        value ? redactTrajectory(value, (text) => this.redactor(run).apply(text)) : null,
      )
      .catch((error) => {
        const message = this.redactor(run).apply((error as Error).message);
        const events = this.store.events(id);
        if (!events.some((event) => event.kind === "trajectory_error" && event.message === message))
          this.store.addEvent(id, "trajectory_error", message);
        throw new UserError(`trajectory unavailable: ${message}`);
      });
    this.trajectoryJobs.set(id, work);
    try {
      return await work;
    } finally {
      if (this.trajectoryJobs.get(id) === work) this.trajectoryJobs.delete(id);
    }
  }

  recordTrajectory(id: string, trajectory: AtifTrajectory | null): void {
    const run = this.mustGet(id);
    if (!isTerminal(run.state) || run.cleanup !== "done") return;
    const summary = trajectory ? trajectorySummary(trajectory) : null;
    const tokens = trajectory ? trajectoryTokens(trajectory) : null;
    if (
      JSON.stringify(run.trajectory) === JSON.stringify(summary) &&
      JSON.stringify(run.tokens) === JSON.stringify(tokens)
    )
      return;
    run.trajectory = summary;
    run.tokens = tokens;
    this.save(run);
  }

  /** Remove credential files from the Agent home; keep a refreshed Codex login. */
  private finishAuth(run: Run): void {
    cleanup.finishAuth(this.context, run);
  }

  /**
   * Redacts every stored secret, plus the run's secret-looking `passEnv` values; rebuilt per use so
   * new or changed profiles are covered.
   */
  redactor(run?: Run): Redactor {
    const extra = run
      ? [...run.spec.passEnv, ...(run.spec.after?.passEnv ?? [])]
          .filter((k) => SECRET_NAME.test(k))
          .map((k) => process.env[k] ?? "")
          .filter((v) => v.length >= 8)
      : [];
    return new Redactor([...(this.deps.auth?.allSecrets() ?? []), ...extra]);
  }

  private async cleanup(run: Run): Promise<void> {
    return cleanup.cleanup(this.context, run);
  }

  /** Record the size of a finished run's directory (outputs no longer change once cleaned up). */
  private async measure(id: string): Promise<void> {
    return cleanup.measure(this.context, id);
  }

  /** Measure finished runs recorded before sizes were (one at a time, in the background). */
  private async measureMissing(): Promise<void> {
    return cleanup.measureMissing(this.context);
  }

  private async retryCleanup(): Promise<void> {
    return cleanup.retryCleanup(this.context);
  }

  /** Reattach to runs that were active when the daemon last stopped. */
  private async recover(first = true): Promise<void> {
    for (const run of this.store.listRuns({ states: ["starting", "running"], limit: 10_000 })) {
      if (this.active.has(run.id)) continue;
      if (run.remote) {
        if (!first) continue;
        // Mirrored from a worker; the cluster sync resumes it (or re-sends it if never confirmed).
        const sync = this.store.getSync(run.id);
        if (sync && !sync.confirmed) void this.dispatchRemote(run.id);
        continue;
      }
      if (run.spec.backend === "process") {
        await this.recoverProcess(run);
        continue;
      }
      let st: docker.ContainerStatus | null;
      try {
        st = await docker.inspectContainer(run.containerId ?? containerName(run.id));
      } catch (e) {
        // Docker is not answering: never conclude the run is lost from that; try again later.
        console.error(`orbit: recover ${run.id}:`, (e as Error).message);
        setTimeout(() => void this.recover(false), DOCKER_RETRY_MS * 6).unref();
        return;
      }
      // Gone with no recorded exit code: Orbit cannot tell how the command ended, so the run is lost
      // (bench treats that as unknown), not failed. With a recorded exit, the ending phases go on.
      const recordedExit =
        run.exitCode ?? phases.readCode(join(this.dirs(run.id).orbit, "phases", "main.exit"));
      if (!st && recordedExit === null) {
        await this.finalize(run, "lost", null, "container not found after daemon restart");
        continue;
      }
      if (st && (!run.containerId || run.state === "starting")) {
        run.containerId = st.id;
        run.state = "running";
        run.startedAt ??= nowIso();
      }
      this.save(
        run,
        "recovered",
        st?.running ? "reattached after daemon restart" : "collected after daemon restart",
      );
      const ctl = this.control(run.id);
      ctl.cancel = run.stopRequested ?? undefined;
      if (st?.running && run.exitCode === null) {
        if (ctl.cancel) this.requestStop(run, ctl.cancel);
        else this.armTimeout(run);
      }
      const id = st?.id ?? run.containerId ?? containerName(run.id);
      void this.watch(run.id, id, true)
        .catch((e) => {
          if (!(e instanceof phases.WatchStopped))
            console.error(`orbit: run ${run.id}:`, (e as Error).message);
        })
        .finally(() => this.active.delete(run.id));
    }
  }

  // ---- resource use ----

  /** cgroup directories of containers by id, cached (a container keeps its cgroup). */
  private readonly cgroupDirs = new Map<string, string>();

  private async containerCgroups(ids: string[]): Promise<string[]> {
    return sampling.containerCgroups(this.context, ids);
  }

  /** Sample a run's resource use while it runs; samples are saved without a change event. */
  private startUsage(id: string, targets: () => Promise<Targets>): void {
    sampling.startUsage(this.context, id, targets);
  }

  /** Stop sampling and put the final figures on `run` (saved with its terminal state). */
  private async stopUsage(run: Run, oomKilled: boolean): Promise<void> {
    return sampling.stopUsage(this.context, run, oomKilled);
  }

  // ---- persistence ----

  private mustGet(id: string): Run {
    const r = this.store.getRun(id);
    if (!r) throw new NotFoundError(`run ${id} not found`);
    return r;
  }

  private save(run: Run, kind?: string, message?: string): void {
    this.store.putRun(run);
    const event = kind ? this.store.addEvent(run.id, kind, message ?? "") : undefined;
    this.changed(run, event);
  }

  private changed(run: Run, event?: RunEvent): void {
    const change = { run: structuredClone(run), event };
    this.store.afterCommit(() => this.emit("change", change));
  }
}
