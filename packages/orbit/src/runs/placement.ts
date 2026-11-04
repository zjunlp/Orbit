// Placement across nodes. The run service owns the decision; the cluster module implements
// `RemotePlacement` (heartbeats, code transfer, mirroring) and is injected at startup, so `runs`
// does not depend on `cluster`.
import {
  type Lease,
  leaseRequest,
  type NodeProfile,
  type NodeResources,
  type Run,
  type RunSpec,
  roleRequests,
} from "../contracts/index.ts";
import { infeasible } from "../resources/allocate.ts";

/** A worker node as last reported by its heartbeat. */
export interface RemoteNode {
  name: string;
  online: boolean;
  /** Null until the first successful heartbeat. */
  resources: NodeResources | null;
  /** Active leases on that node, as it reports them. */
  leases: Lease[];
  datasets: string[];
  profiles: NodeProfile[];
}

export type DispatchResult =
  | { ok: true }
  /**
   * `rejected`: the node refused the run (do not retry there); `unreachable`: nothing was sent;
   * `unknown`: the submission may or may not have arrived (the mirror sync resolves it).
   */
  | { ok: false; kind: "rejected" | "unreachable" | "unknown"; message: string };

export interface RemotePlacement {
  nodes(): RemoteNode[];
  /** Send a placed run (state `starting`, `remote`, `node` set) to its node. */
  dispatch(run: Run): Promise<DispatchResult>;
  /** Ask the node to cancel; failures are retried by the mirror sync. */
  cancel(run: Run): Promise<void>;
}

/**
 * Why `spec` can never run on `node` as it is configured now, or null. Offline nodes are judged on
 * their last report; the scheduler additionally waits for them to be online.
 */
export function remoteBlocker(spec: RunSpec, node: RemoteNode): string | null {
  if (spec.resources.node && spec.resources.node !== node.name)
    return `pinned to ${spec.resources.node}`;
  if (!node.resources) return "not reachable yet";
  if (spec.backend === "process") return "process runs stay on the submitting node";
  if (spec.checkpoint) return "checkpoint runs stay on the submitting node";
  if (spec.services.length) return "runs with services stay on the submitting node";
  const host = spec.mounts.find((m) => m.source);
  if (host) return `host path mount ${host.source} stays on the submitting node`;
  if (spec.project && !spec.snapshot)
    return "a project without snapshot stays on the submitting node";
  const missing = spec.mounts
    .map((m) => m.dataset)
    .filter((d): d is string => Boolean(d) && !node.datasets.includes(d as string));
  if (missing.length) return `dataset ${missing.join(", ")} not registered there`;
  if (spec.auth) {
    const p = node.profiles.find((x) => x.name === spec.auth);
    if (!p) return `auth profile ${spec.auth} not configured there`;
    if (!p.cli) return `${p.harness} CLI not installed there`;
  }
  return infeasible(leaseRequest(spec), node.resources, roleRequests(spec));
}

/**
 * Leases on `node` for allocation: what it reports, plus the predicted leases of runs placed there
 * that it has not reported yet (just dispatched, or queued on the worker).
 */
export function nodeLeases(node: RemoteNode, mirrors: Run[]): Lease[] {
  const seen = new Set(node.leases.map((l) => l.runId));
  const extra = mirrors
    .filter((r) => r.node === node.name && r.lease?.state === "active" && !seen.has(r.id))
    .map((r) => r.lease as Lease);
  return [...node.leases, ...extra];
}

/** One queue reason for all candidate nodes. */
export function joinReasons(reasons: [string, string][]): string {
  if (reasons.length === 1) return reasons[0]?.[1] ?? "";
  return reasons.map(([n, r]) => `${n}: ${r}`).join("; ");
}
