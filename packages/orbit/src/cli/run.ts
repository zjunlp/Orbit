import { resolve } from "node:path";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import { isTerminal, type Run, type RunSpecInput, runDisplayName } from "../contracts/index.ts";
import { exec } from "../lib/exec.ts";
import { detectAgent } from "./agent.ts";
import { parseDataset } from "./cluster.ts";
import { formatDoctor } from "./format.ts";
import { collect, kv, num } from "./options.ts";

export interface RunOpts {
  name?: string;
  group?: string;
  project?: string | false;
  image?: string;
  dockerfile?: string;
  gpus: number;
  gpuMem?: number;
  gpuIds?: string;
  cpus: number;
  mem: number;
  mount: string[];
  dataset: string[];
  node?: string;
  env: string[];
  passEnv: string[];
  network: boolean;
  hostNetwork?: boolean;
  auth?: string;
  snapshot: boolean;
  root?: boolean;
  commandUser?: string;
  timeout?: number;
  checkpoint?: number;
  trajectory?: string;
  tag: string[];
  json?: boolean;
  wait?: boolean;
  folder?: string;
  check?: boolean;
  smoke?: string;
  smokeTimeout: number;
}

export function addRunOptions(cmd: Command): Command {
  return cmd
    .option("-n, --name <name>", "run name")
    .option("-g, --group <group>", "group runs (sweeps, ablations) for comparison")
    .option(
      "-f, --folder <path>",
      "file the run in a folder, e.g. rcb/noskills (orbit mv to change)",
    )
    .option("--project <dir>", "git repo to snapshot into /workspace (default: current repo)")
    .option("--no-project", "do not mount or snapshot any project")
    .option("--image <image>", "docker image")
    .option("--dockerfile <path>", "build the image from this Dockerfile (context: its directory)")
    .option("--gpus <n>", "number of GPUs", num, 0)
    .option("--gpu-mem <GB>", "minimum memory per GPU", num)
    .option("--gpu-ids <ids>", "pin GPUs (comma-separated UUIDs or indexes)")
    .option("--cpus <n>", "CPU limit", num, 4)
    .option("--mem <GB>", "memory limit in GB", num, 16)
    .option("-m, --mount <src:dst[:rw]>", "bind mount (read-only unless :rw)", collect, [])
    .option(
      "-d, --dataset <name[:dst[:rw]]>",
      "mount a registered dataset (orbit data ls; default /data/<name>, read-only)",
      collect,
      [],
    )
    .option("--node <name>", "run on this node (default: any node that can run it)")
    .option(
      "-e, --env <KEY=VALUE>",
      "environment variable (stored with the run: no secrets)",
      collect,
      [],
    )
    .option(
      "--pass-env <VAR>",
      "pass this variable from the daemon's environment (for secrets; the value is not stored)",
      collect,
      [],
    )
    .option("--no-network", "disable networking")
    .option("--host-network", "share the host network (e.g. to reach a proxy on 127.0.0.1)")
    .option(
      "--auth <profile>",
      "mount the Agent CLI with this credential profile (orbit auth list)",
    )
    .option("--no-snapshot", "mount the project read-only instead of snapshotting it")
    .option(
      "--checkpoint <GB>",
      "save a failure checkpoint up to this size (shared image layers excluded)",
      num,
    )
    .option(
      "--trajectory <path>",
      "import native ATIF from this relative output path after execution",
    )
    .option("--root", "run as root instead of your user")
    .option(
      "--command-user <user>",
      "run the command as an existing image account (needs --root --no-project)",
    )
    .option("--timeout <min>", "stop the run after this many minutes", num)
    .option("-t, --tag <KEY=VALUE>", "tag", collect, [])
    .option("-w, --wait", "wait for completion and exit with the run's status")
    .option("--check", "only run the pre-flight checks (data, output disk, image, placement)")
    .option(
      "--smoke <command>",
      "first run this short shell command with the same settings; submit only if it succeeds",
    )
    .option("--smoke-timeout <min>", "time limit of the smoke run", num, 15)
    .option("--json", "print JSON");
}

/**
 * Pre-flight checks of `spec` on the daemon. Prints them all with --check, else only warnings and
 * failures. False when nothing should be submitted.
 */
export async function preflight(c: OrbitClient, spec: RunSpecInput, o: RunOpts): Promise<boolean> {
  const r = await c.check(spec);
  if (o.check) {
    console.log(o.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
    if (!r.ok) process.exitCode = 1;
    return false;
  }
  const notable = r.checks.filter((x) => !x.ok || x.warn);
  if (notable.length) console.error(formatDoctor({ ok: r.ok, checks: notable }));
  if (!r.ok) process.exitCode = 1;
  return r.ok;
}

/**
 * The --smoke run: `spec` with the smoke command (in `sh -c`, `{key}` substituted), outside any
 * group. Returns its id when it succeeded, else null.
 */
export async function smokeRun(
  c: OrbitClient,
  spec: RunSpecInput,
  o: RunOpts,
  params: Record<string, string> = {},
): Promise<string | null> {
  const command = ["sh", "-c", substitute([o.smoke ?? ""], params)[0] ?? ""];
  const run = await c.submit(
    {
      ...spec,
      name: `${runDisplayName(spec)} (smoke)`,
      group: undefined,
      params: {},
      tags: { ...spec.tags, smoke: "true" },
      command,
      timeoutMin: o.smokeTimeout,
    },
    o.folder,
  );
  console.error(`smoke run ${run.id} submitted; waiting for it`);
  const r = await waitUntilCleaned(c, run.id);
  if (r.state === "succeeded") {
    console.error(`smoke run ${r.id} succeeded`);
    return r.id;
  }
  console.error(
    `smoke run ${r.id} ${r.state}${r.reason ? ` (${r.reason})` : ""}; nothing else submitted (orbit logs ${r.id})`,
  );
  process.exitCode = 1;
  return null;
}

async function gitRoot(dir: string): Promise<string | null> {
  const r = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function buildSpec(
  o: RunOpts,
  command: string[],
  params: Record<string, string> = {},
): Promise<RunSpecInput> {
  if (!o.image && !o.dockerfile) throw new Error("--image or --dockerfile is required");
  let project: string | undefined;
  if (typeof o.project === "string") project = resolve(o.project);
  else if (o.project !== false && (await gitRoot(process.cwd()))) project = process.cwd();
  const mounts = o.mount.map((m) => {
    const parts = m.split(":");
    const [source, target, mode] = parts;
    if (!source || !target || parts.length > 3 || (mode && mode !== "rw" && mode !== "ro")) {
      throw new Error(`--mount must be SRC:DST[:rw]: ${m}`);
    }
    return { source: resolve(source), target, mode: (mode as "rw" | "ro" | undefined) ?? "ro" };
  });
  const datasets = o.dataset.map(parseDataset);
  const gpuIds = o.gpuIds?.split(",").filter(Boolean);
  return {
    name: o.name,
    group: o.group,
    project,
    image: o.image,
    dockerfile: o.dockerfile ? resolve(o.dockerfile) : undefined,
    command,
    resources: {
      // Pinned GPUs without a count: one per pinned id.
      gpus: o.gpus || (gpuIds?.length ?? 0),
      gpuMemGB: o.gpuMem,
      gpuIds,
      cpus: o.cpus,
      memGB: o.mem,
      node: o.node,
    },
    mounts: [...mounts, ...datasets],
    env: kv(o.env, "--env"),
    passEnv: o.passEnv,
    network: o.network,
    hostNetwork: Boolean(o.hostNetwork),
    auth: o.auth,
    snapshot: o.snapshot,
    root: o.root ?? false,
    commandUser: o.commandUser,
    trajectory: o.trajectory ? { format: "atif", path: o.trajectory } : undefined,
    timeoutMin: o.timeout,
    checkpoint: o.checkpoint === undefined ? undefined : { maxSizeGB: o.checkpoint },
    tags: kv(o.tag, "--tag"),
    params,
    agent: detectAgent(),
  };
}

/** Wait for all runs to finish; exit code 1 if any did not succeed. */
export async function waitAll(
  client: OrbitClient,
  ids: string[],
  json: boolean,
  single = false,
): Promise<void> {
  const done: Run[] = [];
  for (const id of ids) {
    const r = await waitUntilCleaned(client, id);
    done.push(r);
    if (!json) console.log(`${r.id}  ${r.state}${r.reason ? ` (${r.reason})` : ""}`);
  }
  if (json) console.log(JSON.stringify(single ? done[0] : done, null, 2));
  if (done.some((r) => r.state !== "succeeded")) process.exitCode = 1;
}

/** Expand `a=1,2 b=x,y` into the cartesian product of parameter assignments. */
export function expandGrid(params: string[]): Record<string, string>[] {
  if (params.length === 0) throw new Error("give at least one --param KEY=V1,V2,...");
  let grid: Record<string, string>[] = [{}];
  for (const p of params) {
    const i = p.indexOf("=");
    if (i <= 0) throw new Error(`--param must be KEY=V1,V2,...: ${p}`);
    const key = p.slice(0, i);
    if (!/^\w+$/.test(key))
      throw new Error(`--param key must be letters, digits or _ (used as {${key}}): ${key}`);
    const values = p
      .slice(i + 1)
      .split(",")
      .filter((v) => v !== "");
    if (values.length === 0) throw new Error(`--param ${key} has no values`);
    grid = grid.flatMap((g) => values.map((v) => ({ ...g, [key]: v })));
  }
  return grid;
}

export function substitute(command: string[], params: Record<string, string>): string[] {
  return command.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m));
}

export async function waitUntilCleaned(client: OrbitClient, id: string): Promise<Run> {
  let run = await client.get(id);
  while (!isTerminal(run.state) || run.cleanup === "pending") run = await client.wait(id, 60);
  return run;
}
