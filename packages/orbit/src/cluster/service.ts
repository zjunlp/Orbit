// Multi-node placement for the run service: worker registry and heartbeats, code transfer as
// content-addressed bundles, and mirroring of remote runs (state, events, log, metrics) into this
// node's store. Also serves this node's own cluster listener when it is exposed to a primary.
import { appendFileSync, existsSync, statSync, truncateSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import {
  type AtifSource,
  CLUSTER_PROTOCOL,
  type ExposeStatus,
  isTerminal,
  type NodeInfo,
  type NodeProfile,
  type NodeStatus,
  type RemoteSubmit,
  type Run,
} from "../contracts/index.ts";
import { nowIso } from "../lib/ids.ts";
import type { DispatchResult, RemoteNode, RemotePlacement } from "../runs/placement.ts";
import { type RunService, UserError } from "../runs/service.ts";
import type { RemoteSync, Store } from "../store/index.ts";
import { packBundle, treeHash } from "../workspace/bundle.ts";
import type { DatasetRegistry } from "../workspace/datasets.ts";
import { NodeClient, NodeError } from "./client.ts";
import { ExposeStore, type NodeEntry, NodeRegistry, parseListen } from "./registry.ts";
import { createWorkerApp, MAX_RAW_CHUNK } from "./worker.ts";

export interface ClusterDeps {
  store: Store;
  runs: RunService;
  datasets: DatasetRegistry;
  profiles: () => Promise<NodeProfile[]>;
  /** nodes.json, cluster.json and the bundle cache. */
  files: { nodes: string; cluster: string; bundles: string };
  heartbeatMs?: number;
  syncMs?: number;
}

interface Seen {
  online: boolean;
  lastSeen: string | null;
  error: string | null;
  info: NodeInfo | null;
}

/** Chunks fetched per file per sync pass (so one large log cannot starve the others). */
const MAX_CHUNKS_PER_PASS = 16;

export class ClusterService implements RemotePlacement {
  private readonly deps: ClusterDeps;
  private readonly registry: NodeRegistry;
  private readonly expose: ExposeStore;
  private readonly seen = new Map<string, Seen>();
  /** Runs whose submission is in flight: not resolved by the sync loop meanwhile. */
  private readonly dispatching = new Set<string>();
  private token: string;
  private listener: { server: ServerType; listen: string } | null = null;
  private listenError: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private beating: Promise<void> | null = null;
  private syncing: Promise<void> | null = null;

  constructor(deps: ClusterDeps) {
    this.deps = deps;
    this.registry = new NodeRegistry(deps.files.nodes);
    this.expose = new ExposeStore(deps.files.cluster);
    this.token = this.expose.read().token;
  }

  async start(): Promise<void> {
    const cfg = this.expose.read();
    if (cfg.listen) await this.listen(cfg.listen).catch(() => {});
    await this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), this.deps.heartbeatMs ?? 2000));
    this.timers.push(setInterval(() => void this.syncAll(), this.deps.syncMs ?? 1000));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.all([this.beating, this.syncing]);
    await this.closeListener();
  }

  // ---- this node as a worker ----

  exposeStatus(): ExposeStatus {
    return {
      node: this.deps.runs.nodeName,
      listen: this.expose.read().listen,
      listening: this.listener !== null,
      error: this.listenError,
    };
  }

  /** Start (or stop, with null) serving the cluster API on `listen`, and remember the choice. */
  async setExpose(listen: string | null): Promise<ExposeStatus> {
    if (listen)
      try {
        parseListen(listen);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    const previous = this.listener?.listen ?? null;
    await this.closeListener();
    this.listenError = null;
    if (listen)
      try {
        await this.listen(listen);
      } catch (e) {
        // Keep serving (and remembering) the previous address.
        if (previous) await this.listen(previous).catch(() => {});
        throw e;
      }
    this.expose.setListen(listen);
    return this.exposeStatus();
  }

  clusterToken(rotate = false): string {
    this.token = (rotate ? this.expose.rotate() : this.expose.read()).token;
    return this.token;
  }

  private async listen(listen: string): Promise<void> {
    const { host, port } = parseListen(listen);
    const app = createWorkerApp({
      runs: this.deps.runs,
      datasets: this.deps.datasets,
      profiles: this.deps.profiles,
      bundles: this.deps.files.bundles,
      token: () => this.token,
    });
    try {
      const server = await new Promise<ServerType>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, hostname: host, port }, () => resolve(s));
        s.once("error", reject);
      });
      this.listener = { server, listen };
    } catch (e) {
      this.listenError = `cannot listen on ${listen}: ${(e as Error).message}`;
      console.error(`orbit cluster: ${this.listenError}`);
      throw new UserError(this.listenError);
    }
  }

  private async closeListener(): Promise<void> {
    const l = this.listener;
    this.listener = null;
    if (!l) return;
    await new Promise<void>((resolve) => {
      l.server.close(() => resolve());
      (l.server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }

  // ---- worker nodes ----

  private client(e: NodeEntry): NodeClient {
    return new NodeClient(e.url, e.token);
  }

  nodes(): RemoteNode[] {
    return this.registry.list().map((e) => {
      const s = this.seen.get(e.name);
      return {
        name: e.name,
        online: s?.online ?? false,
        resources: s?.info?.resources ?? null,
        leases: s?.info?.leases ?? [],
        datasets: s?.info?.datasets ?? [],
        profiles: s?.info?.profiles ?? [],
      };
    });
  }

  nodeStatus(): NodeStatus[] {
    return this.registry.list().map((e) => {
      const s = this.seen.get(e.name);
      return {
        name: e.name,
        url: e.url,
        online: s?.online ?? false,
        lastSeen: s?.lastSeen ?? null,
        error: s?.error ?? (s ? null : "not contacted yet"),
        info: s?.info ?? null,
      };
    });
  }

  /** Register a worker by URL and token; its name is what the worker reports. */
  async addNode(url: string, token: string): Promise<NodeStatus> {
    let info: NodeInfo;
    try {
      info = await new NodeClient(url, token).info();
    } catch (e) {
      throw new UserError(`cannot reach node: ${(e as Error).message}`);
    }
    if (info.protocol !== CLUSTER_PROTOCOL)
      throw new UserError(
        `node ${info.name} speaks cluster protocol ${info.protocol}, this node ${CLUSTER_PROTOCOL}; upgrade Orbit on both`,
      );
    if (info.name === this.deps.runs.nodeName)
      throw new UserError(`node ${info.name} has this node's name; set ORBIT_NODE on one of them`);
    const other = this.registry.get(info.name);
    if (other && other.url.replace(/\/+$/, "") !== url.replace(/\/+$/, ""))
      throw new UserError(`a node named ${info.name} is already registered at ${other.url}`);
    this.registry.put({ name: info.name, url: url.replace(/\/+$/, ""), token });
    this.seen.set(info.name, { online: true, lastSeen: nowIso(), error: null, info });
    void this.deps.runs.tick();
    return this.nodeStatus().find((n) => n.name === info.name) as NodeStatus;
  }

  /** Forget a worker. Runs mirrored from it end as `lost` (they may still run there). */
  removeNode(name: string): boolean {
    if (!this.registry.remove(name)) return false;
    this.seen.delete(name);
    for (const s of this.deps.store.openSyncs())
      if (s.node === name) {
        const run = this.deps.runs.get(s.runId);
        if (run && !isTerminal(run.state) && !this.dispatching.has(s.runId))
          this.deps.runs.loseRemote(s.runId, `node ${name} was removed`);
        else this.deps.store.putSync({ ...s, done: true });
      }
    return true;
  }

  private heartbeat(): Promise<void> {
    this.beating ??= (async () => {
      try {
        let cameOnline = false;
        await Promise.all(
          this.registry.list().map(async (e) => {
            const was = this.seen.get(e.name);
            try {
              const info = await this.client(e).info();
              let error: string | null = null;
              if (info.protocol !== CLUSTER_PROTOCOL)
                error = `cluster protocol ${info.protocol}, expected ${CLUSTER_PROTOCOL}`;
              else if (info.name !== e.name) error = `node now reports name ${info.name}`;
              this.seen.set(e.name, { online: !error, lastSeen: nowIso(), error, info });
              if (!error && !was?.online) cameOnline = true;
            } catch (err) {
              this.seen.set(e.name, {
                online: false,
                lastSeen: was?.lastSeen ?? null,
                error: (err as Error).message,
                info: was?.info ?? null,
              });
            }
          }),
        );
        if (cameOnline) void this.deps.runs.tick();
      } finally {
        this.beating = null;
      }
    })();
    return this.beating;
  }

  private markOffline(name: string, error: string): void {
    const s = this.seen.get(name);
    this.seen.set(name, {
      online: false,
      lastSeen: s?.lastSeen ?? null,
      error,
      info: s?.info ?? null,
    });
  }

  // ---- RemotePlacement ----

  async dispatch(run: Run): Promise<DispatchResult> {
    const entry = this.registry.get(run.node);
    if (!entry) return { ok: false, kind: "rejected", message: "node is not registered" };
    this.dispatching.add(run.id);
    try {
      let prepared: { input: RemoteSubmit; bundles: Map<string, string> };
      try {
        prepared = await this.prepare(run);
      } catch (e) {
        return { ok: false, kind: "rejected", message: (e as Error).message };
      }
      const c = this.client(entry);
      let packing: ReturnType<typeof packBundle> | null = null;
      try {
        for (const [hash, dir] of prepared.bundles)
          if (!(await c.hasBundle(hash))) {
            packing = packBundle(dir);
            await c.putBundle(hash, packing);
          }
      } catch (e) {
        const err = e as NodeError;
        // Packing failed here (e.g. files changed while read): not the node's fault.
        if (packing?.errored)
          return {
            ok: false,
            kind: "rejected",
            message: `code upload: ${packing.errored.message}`,
          };
        if (err.status === null) {
          this.markOffline(entry.name, err.message);
          return { ok: false, kind: "unreachable", message: err.message };
        }
        return { ok: false, kind: "rejected", message: `code upload: ${err.message}` };
      }
      try {
        await c.submit(prepared.input);
        return { ok: true };
      } catch (e) {
        const err = e as NodeError;
        return err.status === null
          ? { ok: false, kind: "unknown", message: err.message }
          : { ok: false, kind: "rejected", message: err.message };
      }
    } finally {
      this.dispatching.delete(run.id);
    }
  }

  /** The submission and the bundles (hash -> local directory) it refers to. */
  private async prepare(run: Run): Promise<{ input: RemoteSubmit; bundles: Map<string, string> }> {
    const bundles = new Map<string, string>();
    const add = async (dir: string) => {
      const h = await treeHash(dir);
      bundles.set(h, dir);
      return h;
    };
    const ws = this.deps.runs.dirs(run.id).workspace;
    const workspace = run.code ? await add(ws) : null;
    let dockerfile: RemoteSubmit["dockerfile"] = null;
    const df = run.spec.dockerfile;
    if (df) {
      const rel = run.code ? relative(run.code.repo, df) : null;
      if (workspace && rel && !rel.startsWith("..") && existsSync(join(ws, rel)))
        dockerfile = { bundle: workspace, path: rel };
      else dockerfile = { bundle: await add(dirname(df)), path: basename(df) };
    }
    const agentBundle = run.spec.agentBundle ? await add(run.spec.agentBundle) : null;
    const { agent: _agent, ...spec } = run.spec;
    return {
      input: {
        id: run.id,
        origin: this.deps.runs.nodeName,
        spec: spec as RemoteSubmit["spec"],
        code: run.code,
        workspace,
        dockerfile,
        agentBundle,
      },
      bundles,
    };
  }

  async cancel(run: Run): Promise<void> {
    const entry = this.registry.get(run.node);
    if (entry) await this.client(entry).cancel(run.id);
  }

  // ---- mirroring ----

  syncAll(): Promise<void> {
    this.syncing ??= (async () => {
      try {
        const open = this.deps.store.openSyncs().filter((s) => !this.dispatching.has(s.runId));
        await Promise.all(
          open.map((s) =>
            this.syncOne(s).catch((e) => {
              if (e instanceof NodeError && e.status === null) this.markOffline(s.node, e.message);
              else console.error(`orbit cluster: sync ${s.runId}:`, (e as Error).message);
            }),
          ),
        );
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOne(sync: RemoteSync): Promise<void> {
    const entry = this.registry.get(sync.node);
    if (!entry || !this.seen.get(sync.node)?.online) return;
    const c = this.client(entry);
    const remote = await c.run(sync.runId);
    if (!remote) {
      if (sync.confirmed)
        this.deps.runs.loseRemote(sync.runId, `${sync.node} no longer has the run`);
      else this.deps.runs.requeueRemote(sync.runId, `${sync.node} did not receive the run`);
      return;
    }
    if (sync.cancel && !isTerminal(remote.state)) await c.cancel(sync.runId).catch(() => {});
    const events = await c.events(sync.runId, sync.eventSeq);
    const dirs = this.deps.runs.dirs(sync.runId);
    // A worker restart re-reads the container log from the start.
    if (events.some((e) => e.kind === "recovered") && existsSync(dirs.log))
      truncateSync(dirs.log, 0);
    await this.pull(c, sync.runId, "log", dirs.log);
    await this.pull(c, sync.runId, "metrics", dirs.metrics);
    this.deps.runs.applyRemote(sync.runId, remote, events);
    // Mirroring ends once the worker has cleaned up; a failed cleanup there may still succeed.
    if (isTerminal(remote.state) && remote.cleanup === "done") {
      const fresh = this.deps.store.getSync(sync.runId);
      if (fresh) this.deps.store.putSync({ ...fresh, done: true });
    }
  }

  /** Append what the worker has beyond the local copy (restarting if the worker's file shrank). */
  private async pull(c: NodeClient, id: string, kind: "log" | "metrics", file: string) {
    let offset = existsSync(file) ? statSync(file).size : 0;
    for (let i = 0; i < MAX_CHUNKS_PER_PASS; i++) {
      const r = await c.raw(id, kind, offset, MAX_RAW_CHUNK);
      // Size 0 is also what a missing file reports: keep the local copy rather than wipe it.
      if (!r || r.size === 0) return;
      if (r.size < offset) {
        truncateSync(file, 0);
        offset = 0;
        continue;
      }
      if (r.data.length > 0) {
        appendFileSync(file, r.data);
        offset += r.data.length;
      }
      if (r.data.length === 0 || offset >= r.size) return;
    }
  }

  // ---- records kept on the worker ----

  private runClient(run: Run): NodeClient {
    const entry = this.registry.get(run.node);
    if (!entry) throw new NodeError(`node ${run.node} is not registered`, 404);
    return this.client(entry);
  }

  artifacts(run: Run) {
    return this.runClient(run).artifacts(run.id);
  }

  trajectory(run: Run, rebuild = false, source?: AtifSource) {
    return this.runClient(run).trajectory(run.id, rebuild, source);
  }
  trajectoryFile(run: Run, rel: string) {
    return this.runClient(run).trajectoryFile(run.id, rel);
  }

  file(run: Run, rel: string): Promise<Response> {
    return this.runClient(run).file(run.id, rel);
  }
}
