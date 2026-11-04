// Explicit Docker doubles over a real Store; the real Docker check is run separately.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { Lease, Run } from "../src/contracts/index.ts";
import * as docker from "../src/executor/docker.ts";
import { reconcile } from "../src/runs/reconcile.ts";
import { Store } from "../src/store/index.ts";

vi.mock("../src/executor/docker.ts", async (original) => ({
  ...(await original<typeof docker>()),
  labelledResources: vi.fn(),
  removeContainer: vi.fn(async () => true),
  removeNetwork: vi.fn(async () => true),
  removeVolume: vi.fn(async () => false),
}));
afterEach(() => vi.clearAllMocks());

const at = new Date().toISOString();
const lease = (id: string, runId: string) =>
  Lease.parse({
    id,
    runId,
    node: "n",
    gpuIds: [],
    cpus: 1,
    memGB: 1,
    state: "active",
    createdAt: at,
    releasedAt: null,
  });
const run = (id: string, state: string, cleanup: string, withLease = false) =>
  Run.parse({
    id,
    spec: { image: "x", command: ["true"] },
    state,
    reason: null,
    exitCode: null,
    node: "n",
    image: "x",
    containerId: null,
    lease: withLease ? lease(`l-${id}`, id) : null,
    code: null,
    cleanup,
    note: "",
    createdAt: at,
    startedAt: at,
    endedAt: state === "running" ? null : at,
  });

it("removes leftovers of finished or deleted runs, keeps live ones and releases leaked leases", async () => {
  const home = mkdtempSync(join(tmpdir(), "orbit-reconcile-"));
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  try {
    const finished = run("done", "succeeded", "done", true);
    store.putRun(finished);
    store.putLease(lease("l-done", "done"));
    store.putRun(run("live", "running", "pending"));
    store.putRun(run("dirty", "failed", "failed"));
    store.putLease(lease("l-gone", "deleted"));
    store.putLease(lease("l-live", "live"));
    vi.mocked(docker.labelledResources).mockResolvedValue([
      { kind: "container", id: "c-done", run: "done" },
      { kind: "container", id: "c-live", run: "live" },
      { kind: "container", id: "c-dirty", run: "dirty" },
      { kind: "container", id: "c-deleted", run: "deleted" },
      { kind: "container", id: "c-unlabelled", run: "" },
      { kind: "network", id: "n-done", run: "done" },
      { kind: "volume", id: "v-done", run: "done" },
    ]);
    const ctx = { store, homeLabel: "h", active: new Map(), stopped: false };
    const r = await reconcile(ctx as never);
    expect(r.removed).toEqual(["container:c-done", "container:c-deleted", "network:n-done"]);
    expect(r.failed).toEqual(["volume:v-done"]);
    expect(r.released.sort()).toEqual(["l-done", "l-gone"]);
    expect(store.activeLeases().map((l) => l.id)).toEqual(["l-live"]);
    expect(store.getRun("done")?.lease?.state).toBe("released");
    expect(vi.mocked(docker.labelledResources)).toHaveBeenCalledWith("h");

    // A run still being watched is never touched, even when its record looks finished.
    vi.clearAllMocks();
    vi.mocked(docker.labelledResources).mockResolvedValue([
      { kind: "container", id: "c-done", run: "done" },
    ]);
    const busy = await reconcile({ ...ctx, active: new Map([["done", {}]]) } as never);
    expect(busy.removed).toEqual([]);

    vi.mocked(docker.labelledResources).mockResolvedValue(null);
    expect(await reconcile(ctx as never)).toMatchObject({ skipped: true, removed: [] });
    expect(docker.removeContainer).not.toHaveBeenCalled();
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("holds new local starts on a nearly full disk or while too many runs are starting", async () => {
  const { hostProtection } = await import("../src/resources/allocate.ts");
  const res = (freeGB: number) => ({ disk: { path: "/", totalGB: 1000, freeGB } }) as never;
  expect(hostProtection(res(100), 1, 4)).toBeNull();
  expect(hostProtection(res(3), 0, 4)).toMatch(/data disk has 3 GB free/);
  expect(hostProtection(res(100), 4, 4)).toMatch(/at most 4 start at once/);
});
