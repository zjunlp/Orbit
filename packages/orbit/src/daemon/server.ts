import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ServerType, serve } from "@hono/node-server";
import { AuthStore } from "../auth/index.ts";
import { BenchmarkRegistry } from "../bench/registry.ts";
import { BenchService } from "../bench/service.ts";
import { ClusterService } from "../cluster/service.ts";
import { removeDaemonInfo, writeDaemonInfo } from "../config/daemon-info.ts";
import { ensureHome, type OrbitPaths, tightenPrivateState } from "../config/paths.ts";
import {
  API_PREFIX,
  isTerminal,
  type NodeProfile,
  type NodeResources,
} from "../contracts/index.ts";
import { FeishuBots } from "../feishu/index.ts";
import { AgentRegistry } from "../harness/registry.ts";
import { acquireProcessLock } from "../lib/lock.ts";
import { Notifier, NotifyStore } from "../notify/index.ts";
import { readMetrics } from "../records/index.ts";
import { probeNode } from "../resources/probe.ts";
import { AUTH_TEST_GROUP, RunService } from "../runs/service.ts";
import { Store } from "../store/index.ts";
import { DatasetRegistry } from "../workspace/datasets.ts";
import { createApp } from "./app.ts";

/** Last `n` lines of a text file (reads at most the final 16 KiB). */
function tail(file: string, n: number): string {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

export interface StartedDaemon {
  url: string;
  token: string;
  server: ServerType;
  runs: RunService;
  cluster: ClusterService;
  stop(): Promise<void>;
}

/** Built Web UI: `dist/web` next to the bundled CLI, or `packages/web/dist` in development. */
function findWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "web"), join(here, "../../../web/dist")];
  return candidates.find((d) => existsSync(join(d, "index.html"))) ?? null;
}

export interface DaemonOptions {
  port?: number;
  tickMs?: number;
  /** Resource sampling period of running runs (tests shorten it). */
  usageMs?: number;
  /**
   * Command running this orbit binary (default: detected), for the process-run docker shim and the
   * built-in bench adapters.
   */
  self?: string[];
  /** Worker heartbeat and remote-run sync periods (tests shorten them). */
  heartbeatMs?: number;
  syncMs?: number;
  /** Resource probe (default: this machine); tests pin resources so results do not depend on the host. */
  probe?: () => Promise<NodeResources>;
}

/** `node [execArgv] <entry>` when this process is the orbit CLI (not e.g. a test runner). */
function detectSelf(): string[] | undefined {
  const entry = process.argv[1];
  if (!entry || !/^(bin\.ts|cli\.mjs|orbit)$/.test(basename(entry))) return undefined;
  return [process.execPath, ...process.execArgv, entry];
}

/** Start the daemon on 127.0.0.1: open the store, recover runs, serve the API, publish endpoint + token. */
export async function startDaemon(
  paths: OrbitPaths,
  opts: DaemonOptions = {},
): Promise<StartedDaemon> {
  ensureHome(paths);
  const release = acquireProcessLock(join(paths.home, "daemon.lock"));
  let store: Store | undefined;
  try {
    tightenPrivateState(paths);
    store = new Store(paths.db);
    if (store.migrationBackup)
      console.error(`orbit: database upgraded; pre-migration backup at ${store.migrationBackup}`);
    tightenPrivateState(paths);
    return await startLockedDaemon(paths, opts, store, release);
  } catch (e) {
    store?.close();
    release();
    throw e;
  }
}

async function startLockedDaemon(
  paths: OrbitPaths,
  opts: DaemonOptions,
  store: Store,
  release: () => void,
): Promise<StartedDaemon> {
  const token = randomBytes(24).toString("hex");
  const auth = new AuthStore(paths.auth);
  const agents = new AgentRegistry(paths.agents);
  const datasets = new DatasetRegistry(paths.datasets);
  const self = opts.self ?? detectSelf();
  const runs = new RunService({
    store,
    paths,
    auth,
    agents,
    datasets,
    probe: opts.probe ?? (() => probeNode(paths.data, { node: paths.node, gpus: paths.gpus })),
    tickMs: opts.tickMs,
    usageMs: opts.usageMs,
    shim: self,
  });
  const cluster = new ClusterService({
    store,
    runs,
    datasets,
    profiles: () =>
      Promise.all(
        auth.list().map(async (p): Promise<NodeProfile> => {
          const def = agents.get(p.harness);
          return {
            name: p.name,
            harness: p.harness,
            // An Agent that installs in the run needs nothing from this node.
            cli: def ? def.install.kind !== "host" || Boolean(await agents.host(def)) : false,
          };
        }),
      ),
    files: { nodes: paths.nodes, cluster: paths.cluster, bundles: paths.bundles },
    heartbeatMs: opts.heartbeatMs,
    syncMs: opts.syncMs,
  });
  runs.setRemote(cluster);
  const benchmarks = new BenchmarkRegistry(paths.benchmarks);
  const bench = new BenchService({
    store,
    runs,
    registry: benchmarks,
    paths,
    auth,
    self,
    log: (msg) => console.error(`orbit ${msg}`),
  });
  let webUrl: string | undefined;
  const notifyStore = new NotifyStore(paths.notify);
  const notifier = new Notifier({
    store: notifyStore,
    groupRuns: (group) => store.listRuns({ group, limit: 10_000 }),
    logTail: (id) => runs.redactor().apply(tail(runs.dirs(id).log, 15)),
    metrics: (id) => readMetrics(runs.dirs(id).metrics),
    log: (msg) => console.error(`orbit ${msg}`),
    webUrl: () => webUrl,
  });
  // Bots answer through the daemon's own API (in process, no socket), like any other client.
  let app: ReturnType<typeof createApp> | undefined;
  const feishu = new FeishuBots({
    store: notifyStore,
    api: async <T>(path: string): Promise<T> => {
      if (!app) throw new Error("daemon is starting");
      const res = await app.request(`${API_PREFIX}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    feishu: (t) => notifier.feishu(t),
    log: (msg) => console.error(`orbit ${msg}`),
  });
  runs.on("change", ({ run, event }) => {
    // The terminal event is saved once, before cleanup; auth checks stay quiet, and runs sent here
    // by a primary notify there.
    if (
      event?.kind !== run.state ||
      !isTerminal(run.state) ||
      run.spec.group === AUTH_TEST_GROUP ||
      run.origin
    )
      return;
    void notifier.onTerminal(run);
  });
  app = createApp({
    token,
    startedAt: new Date().toISOString(),
    runs,
    auth,
    agents,
    notifyStore,
    notifier,
    feishu,
    bench,
    benchmarks,
    cluster,
    datasets,
    store,
    paths,
    webDir: findWebDir(),
  });

  const listen = (port: number) =>
    new Promise<ServerType>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => resolve(s));
      s.once("error", reject);
    });
  const wanted = opts.port ?? paths.port;
  const server = await listen(wanted).catch((e: NodeJS.ErrnoException) => {
    // Another user's daemon on the default port: take any free one. Clients find the daemon
    // through daemon.json, never by the port.
    if (e.code !== "EADDRINUSE" || opts.port !== undefined || paths.portSet) throw e;
    console.error(`orbit: port ${wanted} is in use (another user's daemon?); using a free port`);
    return listen(0);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? paths.port);
  const url = `http://127.0.0.1:${port}`;
  webUrl = url;
  try {
    await bench.enforceCalibrationBudgets();
    await runs.start();
    await cluster.start();
    bench.start();
    void feishu.sync();
    writeDaemonInfo(paths, { url, token, pid: process.pid });
  } catch (e) {
    bench.stop();
    feishu.stop();
    await cluster.stop();
    await runs.stop();
    server.close();
    throw e;
  }

  const stop = async () => {
    removeDaemonInfo(paths, process.pid);
    feishu.stop();
    bench.stop();
    await cluster.stop();
    await runs.stop();
    await new Promise<void>((done) => {
      server.close(() => done());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    store.close();
    release();
  };
  return { url, token, server, runs, cluster, stop };
}
