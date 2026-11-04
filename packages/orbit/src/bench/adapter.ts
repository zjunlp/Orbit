// The adapter side of the bench protocol (design §7). An adapter lists tasks, describes the solve and
// verify runs of a trial and reads the score; it never submits or watches runs. Built-in adapters
// implement `AdapterHandlers` and run as `orbit __adapter <name> <op>`, exactly like an external one.
import {
  AdapterOp,
  AdapterRequest,
  type AdapterTasksResponseInput,
  type BenchTask,
  type MetricSpecInput,
  type ORBIT_OWNED_SPEC_FIELDS,
  type RunSpecInput,
  type ScoreResult,
} from "../contracts/index.ts";

/** A run as an adapter describes it (see `contracts.AdapterRunSpec`). */
export type RunDescription = Omit<
  RunSpecInput,
  (typeof ORBIT_OWNED_SPEC_FIELDS)[number] | "command"
> & { command?: string[]; agentTask?: { instruction: string } };
export interface SpecReply {
  spec: RunDescription;
  issues?: string[];
}

export type TrialRequest = AdapterRequest & { trial: NonNullable<AdapterRequest["trial"]> };
export type VerifyRequest = TrialRequest & { solve: NonNullable<AdapterRequest["solve"]> };
export type ScoreRequest = VerifyRequest & { verify: NonNullable<AdapterRequest["verify"]> };
export type ScoreReply = Pick<ScoreResult, "score"> & Partial<ScoreResult>;

export interface AdapterHandlers {
  /** Metrics besides `score` (or a relabelled `score`), declared with the tasks. */
  metrics?: MetricSpecInput[];
  /** What the `tasks` reply declares besides the tasks, when it depends on the registration. */
  info?(req: AdapterRequest): Omit<AdapterTasksResponseInput, "tasks">;
  tasks(req: AdapterRequest): BenchTask[];
  solve(req: TrialRequest): SpecReply;
  verify(req: VerifyRequest): SpecReply;
  score(req: ScoreRequest): ScoreReply;
}

/** Dispatch one request; throws when it lacks what the op needs. */
export function handle(h: AdapterHandlers, req: AdapterRequest): unknown {
  const need = (k: "trial" | "solve" | "verify") => {
    if (!req[k]) throw new Error(`${req.op} request without ${k}`);
  };
  if (req.op === "tasks")
    return { tasks: h.tasks(req), metrics: h.metrics ?? [], ...h.info?.(req) };
  need("trial");
  if (req.op === "solve") return h.solve(req as TrialRequest);
  need("solve");
  if (req.op === "verify") return h.verify(req as VerifyRequest);
  need("verify");
  return h.score(req as ScoreRequest);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Entry point of `orbit __adapter <name> <op>`: request on stdin, response on stdout. */
export async function adapterMain(name: string, op: string): Promise<void> {
  try {
    const handlers = await builtin(name);
    const req = AdapterRequest.parse(JSON.parse(await readStdin()));
    if (req.op !== AdapterOp.parse(op))
      throw new Error(`op ${op} does not match request ${req.op}`);
    process.stdout.write(`${JSON.stringify(handle(handlers, req))}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

async function builtin(name: string): Promise<AdapterHandlers> {
  if (name === "harbor") return (await import("./harbor.ts")).harborAdapter;
  if (name === "asi") return (await import("./asi.ts")).asiAdapter;
  if (name === "manifest") return (await import("./manifest.ts")).manifestAdapter;
  throw new Error(`unknown built-in adapter: ${name}`);
}
