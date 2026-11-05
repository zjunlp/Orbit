import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { RunDirs } from "../config/paths.ts";
import type { AgentDefinition, Run } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { agentHomeDir, containerPath, type Prepared, prepareAgent } from "../harness/index.ts";
import { installAgentTools } from "../harness/mcp.ts";
import { nowIso } from "../lib/ids.ts";
import { copyTreeInto, readRegular, realDirs } from "../lib/safe-fs.ts";
import type { RunContext } from "./context.ts";
import { type Control, containerName, GENERIC_DIRS, usesRunNetworks } from "./execution.ts";
import { keepsContainer, runCommand, stopMain, WatchStopped, writePhaseScript } from "./phases.ts";
import { volumeName } from "./services.ts";

type Context = Pick<
  RunContext,
  | "active"
  | "armTimeout"
  | "buildFile"
  | "bundleTag"
  | "containerSpec"
  | "deps"
  | "dirs"
  | "ensureImage"
  | "envFile"
  | "finalize"
  | "gpuMode"
  | "homeLabel"
  | "launchProcess"
  | "mustGet"
  | "networkNames"
  | "node"
  | "passEnv"
  | "paths"
  | "prepareAuth"
  | "redactor"
  | "save"
  | "startServices"
  | "store"
  | "watch"
>;

export async function launch(ctx: Context, id: string): Promise<void> {
  const ctl: Control = {};
  ctx.active.set(id, ctl);
  let run = ctx.mustGet(id);
  const dirs = ctx.dirs(id);
  const envFile = ctx.envFile(id);
  if (run.spec.backend === "process") return ctx.launchProcess(run, dirs, ctl);
  try {
    const image = await ctx.ensureImage(run, dirs);
    const imageId = await docker.imageId(image);
    run = ctx.mustGet(id);
    if (ctl.cancel)
      return void (await ctx.finalize(run, "cancelled", null, "cancelled before start"));

    const spec = ctx.containerSpec(run, dirs, image);
    if (run.spec.checkpoint) {
      const volumes = (await docker.imageVolumes(image)).filter(
        (p) => !spec.mounts.some((m) => m.target === p),
      );
      if (volumes.length)
        throw new Error(`checkpoints do not support image volumes: ${volumes.join(", ")}`);
    }
    if (keepsContainer(run.spec)) writePhaseScript(join(dirs.orbit, "phases"));
    if (usesRunNetworks(run.spec)) {
      // Before the run's container: a failure here is the environment's, not the method's.
      await ctx.startServices(id, dirs, ctl);
      if (ctl.cancel)
        return void (await ctx.finalize(
          ctx.mustGet(id),
          "cancelled",
          null,
          "cancelled before start",
        ));
      run = ctx.mustGet(id);
      spec.networks = ctx
        .networkNames(run)
        .filter((n) => run.spec.runNetworks.includes(n.short))
        .map((n) => ({ name: n.name, aliases: ["main"] }));
    }
    const secretEnv = ctx.passEnv(run);
    if (run.spec.auth) {
      const h = await ctx.prepareAuth(run, dirs);
      const imagePath = run.spec.env.PATH ?? (await docker.imagePath(image));
      if (h.cli) h.env.PATH = containerPath(h.cli.pathDirs, imagePath);
      if (h.setup) {
        // An Agent that installs inside the run: the install script runs before the command, and a
        // failure is recorded as the environment's (see `AGENT_INSTALL_FAILED`), not the method's.
        writeFileSync(join(dirs.agent, AGENT_SETUP_FILE), `${h.setup}\n`, { mode: 0o700 });
        spec.command = withAgentSetup(spec.command);
        ctx.store.addEvent(run.id, "harness", "installing the Agent CLI inside the container");
      }
      spec.mounts.push(...h.mounts);
      Object.assign(spec.env, h.env);
      Object.assign(secretEnv, h.secretEnv);
    }
    if (Object.keys(secretEnv).length > 0) {
      writeFileSync(envFile, docker.envFileText(secretEnv), { mode: 0o600 });
      spec.envFile = envFile;
    }
    const containerId = await docker
      .startContainer(spec)
      .finally(() => rmSync(envFile, { force: true }));
    run = ctx.mustGet(id);
    run.image = image;
    run.imageId = imageId;
    run.containerId = containerId;
    run.state = "running";
    run.startedAt = nowIso();
    ctx.save(run, "started", `container ${containerId.slice(0, 12)}`);
    if (ctl.cancel)
      void (keepsContainer(run.spec)
        ? stopMain(ctx, containerId)
        : docker.stopContainer(containerId));

    const st = await docker.inspectContainer(containerId);
    const want = [...mainGpus(run)].sort().join(",");
    const got = [...(st?.gpuIds ?? [])].sort().join(",");
    if (want !== got) {
      // Stop it, then collect logs and outputs as for any failure before the container goes.
      ctl.fail = `GPU mapping mismatch: leased [${want}] but container has [${got}]`;
      appendFileSync(dirs.log, `[orbit] ${ctl.fail}\n`);
      void docker.stopContainer(containerId);
    } else ctx.armTimeout(run);
    await ctx.watch(id, containerId, false);
  } catch (e) {
    if (e instanceof WatchStopped) return;
    const msg = (e as Error).message;
    appendFileSync(dirs.log, `\n[orbit] ${ctx.redactor(run).apply(msg)}\n`);
    await ctx.finalize(ctx.mustGet(id), "failed", null, msg);
  } finally {
    ctx.active.delete(id);
  }
}

export function envFile(ctx: Context, id: string): string {
  return join(ctx.paths.tmp, `${id}.env`);
}

export function passEnv(ctx: Context, run: Run): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of run.spec.passEnv) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
    else ctx.store.addEvent(run.id, "env", `${k} is not set in the daemon environment`);
  }
  return out;
}

/** The Agent's install script, in the Agent home (mounted at /orbit/agent). */
export const AGENT_SETUP_FILE = ".orbit-setup.sh";
/** Written by the wrapper when the install script fails; the run is then an environment failure. */
export const AGENT_SETUP_FAILED = ".orbit-setup.failed";
/** Reason prefix of a run whose Agent could not be installed. */
export const AGENT_INSTALL_FAILED = "Agent install failed";

/**
 * Run the Agent install script, then the command. npm and uv install into the Agent home and the
 * user's ~/.local, which are put first on PATH so the CLI is found without root.
 */
export function withAgentSetup(command: string[]): string[] {
  const script = [
    "a=/orbit/agent",
    `export PATH="\${NPM_CONFIG_PREFIX:+$NPM_CONFIG_PREFIX/bin:}\${HOME:-/tmp}/.local/bin:$PATH"`,
    `sh "$a/${AGENT_SETUP_FILE}" > "$a/setup.log" 2>&1; c=$?`,
    `if [ "$c" -ne 0 ]; then echo "$c" > "$a/${AGENT_SETUP_FAILED}"; echo "[orbit] ${AGENT_INSTALL_FAILED} (exit $c):" >&2; tail -n 40 "$a/setup.log" >&2; exit 125; fi`,
    'exec "$@"',
  ].join("\n");
  return ["/bin/sh", "-c", script, "sh", ...command];
}

export async function prepareAuth(ctx: Context, run: Run, dirs: RunDirs): Promise<Prepared> {
  const name = run.spec.auth as string;
  const entry = ctx.deps.auth?.get(name);
  if (!entry) throw new Error(`auth profile not found: ${name}`);
  const agents = ctx.deps.agents;
  if (!agents) throw new Error("no Agent registry; restart the daemon");
  const def = agents.get(entry.profile.harness);
  if (!def) throw new Error(`unknown Agent: ${entry.profile.harness}`);
  const h = await prepareAgent(def, entry, dirs.agent, { hostCli: (d) => agents.host(d) });
  if (run.spec.agentBundle) {
    installBundle(run.spec.agentBundle, dirs.agent, def);
    ctx.store.addEvent(run.id, "bundle", `method bundle ${run.spec.agentBundle}`);
  }
  ctx.store.addEvent(
    run.id,
    "harness",
    `${h.cli?.version ?? def.name} · auth ${name} (${entry.profile.kind})${run.spec.hostNetwork ? " · host network" : ""}`,
  );
  return h;
}

export async function ensureImage(ctx: Context, run: Run, dirs: RunDirs): Promise<string> {
  const image = run.spec.image;
  if (image) {
    // Pulled here, without the time limit of `docker run`, with progress in the run log.
    if (await docker.imageExists(image)) return image;
    ctx.save(run, "pull", `pulling ${image}`);
    const code = await docker.pullImage(image, dirs.log, docker.imageDeadlineMs());
    if (code === docker.IMAGE_TIMEOUT)
      throw new Error(
        `docker pull ${image} made no progress within ${docker.imageDeadlineMs() / 60_000} min and was stopped (ORBIT_IMAGE_DEADLINE_MIN)`,
      );
    if (code !== 0) throw new Error(`docker pull ${image} failed with exit code ${code}`);
    return image;
  }
  const df = ctx.buildFile(run, dirs);
  if (df !== run.spec.dockerfile)
    ctx.store.addEvent(
      run.id,
      "image",
      `building from the code snapshot (${relative(dirs.workspace, df)})`,
    );
  const dir = basename(dirname(df));
  const name = run.spec.project
    ? basename(run.spec.project)
    : GENERIC_DIRS.has(dir)
      ? `${basename(dirname(dirname(df)))}-${dir}`
      : dir;
  const tag = ctx.bundleTag(df, name) ?? docker.dockerfileTag(df, dirname(df), name);
  if (await docker.imageExists(tag)) {
    ctx.store.addEvent(run.id, "image", `reusing ${tag}`);
    return tag;
  }
  ctx.save(run, "build", `building ${tag}`);
  appendFileSync(dirs.log, `[orbit] docker build -f ${df} -t ${tag}\n`);
  const code = await docker.buildImage(df, dirname(df), tag, dirs.log, {
    hostNetwork: run.spec.hostNetwork,
    timeoutMs: docker.imageDeadlineMs(),
  });
  if (code === docker.IMAGE_TIMEOUT)
    throw new Error(
      `docker build made no progress within ${docker.imageDeadlineMs() / 60_000} min and was stopped (ORBIT_IMAGE_DEADLINE_MIN)`,
    );
  if (code !== 0) throw new Error(`docker build failed with exit code ${code}`);
  appendFileSync(dirs.log, "[orbit] build done\n");
  return tag;
}

export function buildFile(_ctx: Context, run: Run, dirs: RunDirs): string {
  const df = run.spec.dockerfile as string;
  if (!run.code) return df;
  // The repository root is a real path; the Dockerfile may have been given through a symlink.
  const rel = relative(run.code.repo, realOr(df));
  if (rel.startsWith("..") || isAbsolute(rel)) return df;
  const inSnapshot = join(dirs.workspace, rel);
  return existsSync(inSnapshot) ? inSnapshot : df;
}

export function bundleTag(ctx: Context, df: string, name: string): string | null {
  const rel = df.startsWith(`${ctx.paths.bundles}/`)
    ? df.slice(ctx.paths.bundles.length + 1)
    : null;
  if (!rel) return null;
  const hash = createHash("sha256").update(rel).digest("hex").slice(0, 12);
  const repo =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "run";
  return `orbit-local/${repo}:b${hash}`;
}

export function containerSpec(
  ctx: Context,
  run: Run,
  dirs: RunDirs,
  image: string,
): docker.ContainerSpec {
  const s = run.spec;
  const mounts: docker.ContainerSpec["mounts"] = [
    { source: dirs.orbit, target: "/orbit", mode: "rw" },
  ];
  let workdir = "/orbit";
  if (run.code) {
    mounts.push({ source: dirs.workspace, target: "/workspace", mode: "rw" });
    workdir = join("/workspace", run.code.subdir);
  } else if (s.project) {
    mounts.push({ source: s.project, target: "/workspace", mode: "ro" });
    workdir = "/workspace";
  }
  for (const m of s.mounts) {
    const source = m.source ?? ctx.deps.datasets?.path(m.dataset as string);
    if (!source) throw new Error(`dataset ${m.dataset} is not registered on ${ctx.node}`);
    mounts.push({ source, target: m.target, mode: m.mode });
  }
  const workdirOut = s.workdir === "image" ? null : (s.workdir ?? workdir);
  const volumes = s.volumeMounts.map((v) => ({
    name: volumeName(run.id, v.volume),
    target: v.target,
    mode: v.mode,
  }));
  const env: Record<string, string> = {
    ...s.env,
    ORBIT_RUN_ID: run.id,
    ORBIT_OUTPUT: "/orbit/output",
    ORBIT_METRICS: "/orbit/metrics.jsonl",
    PYTHONUNBUFFERED: "1",
  };
  let user: string | null = null;
  if (!s.root) {
    const u = userInfo();
    user = `${u.uid}:${u.gid}`;
    env.HOME ??= "/tmp";
  }
  return {
    name: containerName(run.id),
    image,
    command: runCommand(s),
    ...(s.entrypoint ? { entrypoint: s.entrypoint } : {}),
    labels: { [docker.LABEL_RUN]: run.id, [docker.LABEL_HOME]: ctx.homeLabel },
    gpuIds: mainGpus(run),
    devices: run.lease?.roles.find((r) => r.role === "main")?.devices.flatMap((d) => d.paths) ?? [],
    gpuMode: ctx.gpuMode,
    cpus: s.resources.cpus,
    memGB: s.resources.memGB,
    mounts,
    env,
    workdir: workdirOut,
    network: !s.network ? "none" : s.hostNetwork ? "host" : "bridge",
    user,
    ...(volumes.length ? { volumes } : {}),
    ...(s.pidsLimit ? { pidsLimit: s.pidsLimit } : {}),
    ...(s.shmGB ? { shmGB: s.shmGB } : {}),
  };
}

/**
 * Copy a method bundle into the Agent home. AGENTS.md and CLAUDE.md stand in for each other, so one
 * bundle serves every Agent; each home gets both names.
 */
export function installBundle(bundle: string, agentDir: string, def: AgentDefinition) {
  const home = agentHomeDir(def, agentDir);
  mkdirSync(agentDir, { recursive: true });
  realDirs(agentDir, home);
  copyTreeInto(realpathSync(bundle), home);
  installAgentTools(def, home);
  const names = ["AGENTS.md", "CLAUDE.md"];
  for (const [from, to] of [
    ["AGENTS.md", "CLAUDE.md"],
    ["CLAUDE.md", "AGENTS.md"],
  ] as const)
    if (!lstatSync(join(home, to), { throwIfNoEntry: false }) && readRegular(join(home, from)))
      copyFileSync(join(home, from), join(home, to));
  void names;
}

export const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * GPUs of the run's own container: its `main` role on leases written by role, else the whole lease
 * (a single-container run, or a lease from before roles existed).
 */
export function mainGpus(run: Run): string[] {
  const roles = run.lease?.roles ?? [];
  const main = roles.find((x) => x.role === "main");
  return main ? main.gpuIds : (run.lease?.gpuIds ?? []);
}
