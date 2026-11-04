// Periodic reconciliation (design §9.6, point 6): compare what the ledger says with the Docker
// resources labelled with this Orbit home, and the lease table with the runs. Only resources whose
// run is finished and cleaned up (or no longer exists) are removed; a failed listing skips the round.
import { isTerminal, type ReconcileReport, type Run } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { nowIso } from "../lib/ids.ts";
import type { RunContext } from "./context.ts";

type Context = Pick<RunContext, "store" | "homeLabel" | "active" | "stopped">;

/** `removed` / `failed` are `kind:id`; `skipped`: the Docker listing failed and nothing was decided. */
export type ReconcileResult = ReconcileReport;

/** Whether a run no longer needs anything it created (or no longer exists). */
function done(run: Run | null, active: ReadonlySet<string>): boolean {
  if (!run) return true;
  return isTerminal(run.state) && run.cleanup === "done" && !active.has(run.id) && !run.remote;
}

export async function reconcile(ctx: Context): Promise<ReconcileResult> {
  const out: ReconcileResult = { removed: [], failed: [], released: [], skipped: false };
  const active = new Set(ctx.active.keys());
  for (const lease of ctx.store.activeLeases()) {
    const run = ctx.store.getRun(lease.runId);
    if (!done(run, active)) continue;
    ctx.store.tx(() => {
      lease.state = "released";
      lease.releasedAt = nowIso();
      ctx.store.putLease(lease);
      if (run?.lease?.id === lease.id && run.lease.state === "active") {
        run.lease = { ...run.lease, state: "released", releasedAt: lease.releasedAt };
        ctx.store.putRun(run);
        ctx.store.addEvent(
          run.id,
          "reconcile",
          "lease released (run already finished and cleaned up)",
        );
      }
    });
    out.released.push(lease.id);
  }
  const found = await docker.labelledResources(ctx.homeLabel);
  if (found === null || ctx.stopped) return { ...out, skipped: true };
  const runs = new Map<string, Run | null>();
  const owner = (id: string) => {
    if (!runs.has(id)) runs.set(id, ctx.store.getRun(id));
    return runs.get(id) ?? null;
  };
  // Containers before networks and volumes, as in a run's own cleanup.
  for (const kind of ["container", "network", "volume"] as const)
    for (const r of found.filter((x) => x.kind === kind)) {
      // Without a run label Orbit cannot tell whose it is: leave it.
      if (!r.run || !done(owner(r.run), active)) continue;
      const ok =
        kind === "container"
          ? await docker.removeContainer(r.id)
          : kind === "network"
            ? await docker.removeNetwork(r.id)
            : await docker.removeVolume(r.id);
      (ok ? out.removed : out.failed).push(`${kind}:${r.id}`);
      const run = owner(r.run);
      if (ok && run)
        ctx.store.addEvent(run.id, "reconcile", `removed leftover ${kind} ${r.id.slice(0, 24)}`);
    }
  return out;
}
