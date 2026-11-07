// The daemon side of the bench protocol (design §7): run an adapter executable with a JSON request on
// stdin, validate its JSON reply, and turn an adapter's run description into a RunSpec. Orbit adds
// what it owns: the Agent CLI command, auth and bundle of Agent methods, benchmark env and the
// verifier's pass-through secrets.
import { spawn } from "node:child_process";
import type { z } from "zod";
import type { AgentDefinition } from "../contracts/index.ts";
import {
  ADAPTER_PROTOCOL,
  type AdapterOp,
  type AdapterRequest,
  type AdapterRunRef,
  type AdapterRunSpec,
  type AdapterSolveBatch,
  AdapterSpecResponse,
  AdapterTasksResponse,
  type Benchmark,
  BUILTIN_ADAPTERS,
  isCliMethod,
  type Method,
  RunSpec,
  type RunSpecInput,
  ScoreResult,
} from "../contracts/index.ts";
import { agentCommand } from "../harness/index.ts";
import { agentToolsBundle } from "../harness/mcp.ts";

export class AdapterError extends Error {}

const OUTPUT_LIMIT = 64 * 1024 * 1024;
/** Variables an adapter process sees; secrets in the daemon environment are not passed on. */
const ADAPTER_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export const isBuiltin = (adapter: string) =>
  (BUILTIN_ADAPTERS as readonly string[]).includes(adapter);

/** argv of a benchmark's adapter; built-ins run through this orbit binary (`self`). */
export function adapterArgv(b: Benchmark, self: string[] | undefined): string[] {
  if (!isBuiltin(b.adapter)) return [b.adapter];
  if (!self) throw new AdapterError("built-in adapters are not available in this daemon");
  return [...self, "__adapter", b.adapter];
}

/** Run `<argv> <op>` in the benchmark directory; resolves to the parsed JSON reply. */
export function callAdapter(
  argv: string[],
  cwd: string,
  req: AdapterRequest,
  timeoutMs: number,
): Promise<unknown> {
  const env: NodeJS.ProcessEnv = { ORBIT_ADAPTER_PROTOCOL: String(ADAPTER_PROTOCOL) };
  for (const k of ADAPTER_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return new Promise((resolve, reject) => {
    const fail = (msg: string) => reject(new AdapterError(`adapter ${req.op}: ${msg}`));
    const child = spawn(argv[0] as string, [...argv.slice(1), req.op], {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const abort = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill("SIGTERM");
      // Descendants can outlive the leader and keep its pipes open.
      setTimeout(() => kill("SIGKILL"), 250);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      fail(message);
    };
    const timer = setTimeout(
      () => abort(`timed out after ${Math.round(timeoutMs / 1000)} s`),
      timeoutMs,
    );
    child.stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > OUTPUT_LIMIT) {
        abort("reply larger than 64 MiB");
      } else out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      err = (err + c.toString("utf8")).slice(-4000);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(e.message);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = err.trim().split("\n").slice(-5).join("\n");
      if (code !== 0) return fail(`exit ${code}${detail ? `: ${detail}` : ""}`);
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch {
        fail("stdout is not one JSON value");
      }
    });
    // An adapter may exit without reading its request.
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(req));
  });
}

const describe = (e: z.ZodError) =>
  e.issues.map((i) => `${i.path.join(".") || "reply"}: ${i.message}`).join("; ");

function parse<S extends z.ZodType>(schema: S, op: AdapterOp, v: unknown): z.output<S> {
  const r = schema.safeParse(v);
  if (r.success) return r.data;
  throw new AdapterError(`adapter ${op}: invalid reply: ${describe(r.error)}`);
}

export type TrialInput = NonNullable<AdapterRequest["trial"]>;

/** Typed calls of one benchmark's adapter. */
export class AdapterClient {
  private readonly argv: string[];
  private readonly b: Benchmark;
  private readonly timeoutMs: number;

  constructor(b: Benchmark, self: string[] | undefined, timeoutMs = 120_000) {
    this.argv = adapterArgv(b, self);
    this.b = b;
    this.timeoutMs = timeoutMs;
  }

  private call(op: AdapterOp, rest: Partial<AdapterRequest> = {}): Promise<unknown> {
    const { name, path, config } = this.b;
    return callAdapter(
      this.argv,
      path,
      { protocol: ADAPTER_PROTOCOL, op, benchmark: { name, path, config }, ...rest },
      this.timeoutMs,
    );
  }

  async tasks(): Promise<AdapterTasksResponse> {
    return parse(AdapterTasksResponse, "tasks", await this.call("tasks"));
  }

  async solve(trial: TrialInput, batch?: AdapterSolveBatch) {
    return parse(
      AdapterSpecResponse,
      "solve",
      await this.call("solve", { trial, ...(batch ? { batch } : {}) }),
    );
  }

  async verify(trial: TrialInput, solve: AdapterRunRef) {
    return parse(AdapterSpecResponse, "verify", await this.call("verify", { trial, solve }));
  }

  async score(trial: TrialInput, solve: AdapterRunRef, verify: AdapterRunRef) {
    return parse(ScoreResult, "score", await this.call("score", { trial, solve, verify }));
  }
}

/** The RunSpec of an adapter's run description, with what Orbit owns filled in. */
export function toRunSpec(
  s: AdapterRunSpec,
  method: Method,
  b: Benchmark,
  phase: "solve" | "verify",
  agentDef: () => AgentDefinition,
  staging?: string,
): RunSpecInput {
  const { agentTask, command, ...rest } = s;
  if (agentTask && (phase === "verify" || !isCliMethod(method)))
    throw new AdapterError(
      phase === "verify"
        ? "verify runs cannot ask for an Agent"
        : `the adapter asked for an Agent, but method ${method.name} is ${method.agent}`,
    );
  const spec = {
    ...rest,
    command: agentTask
      ? agentCommand(agentDef(), method, agentTask.instruction, Boolean(agentTask.tools?.length))
      : command,
    env: { ...b.env, ...((rest.env as Record<string, string> | undefined) ?? {}) },
    snapshot: false,
  } as RunSpecInput;
  if (phase === "solve" && isCliMethod(method)) {
    // The Agent reaches its model API; native runners get the auth to inject into their containers.
    spec.auth = method.auth;
    spec.agentBundle = agentToolsBundle(agentDef(), method.bundle, agentTask?.tools, staging);
    spec.network = true;
  }
  if (agentTask && spec.root && spec.backend !== "process") {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined)
      throw new AdapterError("root Agent runs require Unix file ownership support");
    // Root CLIs write private transcripts; return them before an adapter hook stops the container.
    spec.hooks = [
      { command: `chown -hR ${uid}:${gid} /orbit/agent`, timeoutSec: 30 },
      ...(spec.hooks ?? []),
    ];
  }
  if (phase === "solve" && method.agent === "external") {
    spec.passEnv = method.passEnv ?? [];
  }
  if (phase === "solve" && spec.after) {
    // A verifier in the solve container (after the Agent) gets the grader secrets for its phase only.
    spec.after = { ...spec.after, passEnv: b.passEnv };
  }
  if (phase === "verify") {
    // Grader secrets go to the verifier, never to the Agent under test.
    spec.passEnv = b.passEnv;
    spec.priority = 1;
  }
  const r = RunSpec.safeParse(spec);
  if (!r.success) throw new AdapterError(`invalid ${phase} run: ${describe(r.error)}`);
  return spec;
}
