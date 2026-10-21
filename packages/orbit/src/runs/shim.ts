// The `docker` seen by process runs (native benchmark runners). It labels the containers they start
// so Orbit can stop and remove them, maps `--gpus` to the run's lease, injects the Agent CLI and its
// credentials, and otherwise passes everything to the real docker unchanged.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { LABEL_HOME, LABEL_PARENT } from "../executor/docker.ts";
import { AGENT_HOME, containerPath } from "../harness/index.ts";

export interface ShimConfig {
  realDocker: string;
  /** DOCKER_CONFIG for the real docker (the runner's HOME is private). */
  dockerConfig: string;
  runId: string;
  homeLabel: string;
  gpuIds: string[];
  gpuMode: "cdi" | "gpus";
  hostNetwork: boolean;
  /** Agent CLI + credentials for containers the runner starts; null without `spec.auth`. */
  auth: {
    mounts: { source: string; target: string; mode: "ro" | "rw" }[];
    /** Host directory mounted at /orbit/agent (CODEX_HOME / CLAUDE_CONFIG_DIR live under it). */
    agentDir: string;
    env: Record<string, string>;
    envFile: string | null;
    pathDirs: string[];
  } | null;
}

/** Global docker options that take a value. */
const GLOBAL_VALUE = new Set(["-H", "--host", "-c", "--context", "--config", "-l", "--log-level"]);
/** `docker run` / `create` options without a value. */
const RUN_BOOL = new Set([
  "-d",
  "-i",
  "-t",
  "-P",
  "-q",
  "--rm",
  "--init",
  "--privileged",
  "--read-only",
  "--detach",
  "--interactive",
  "--tty",
  "--publish-all",
  "--oom-kill-disable",
  "--no-healthcheck",
  "--disable-content-trust",
  "--quiet",
  "--help",
  "--use-api-socket",
  "--sig-proxy",
]);
const SHORT_BOOL = new Set(["d", "i", "t", "P", "q"]);

export class ShimError extends Error {}

/** Index of the (sub)command after global options. */
function commandIndex(args: string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (!a.startsWith("-")) return i;
    i += GLOBAL_VALUE.has(a) ? 2 : 1;
  }
  return i;
}

function gpuArgs(cfg: ShimConfig): string[] {
  if (cfg.gpuIds.length === 0)
    throw new ShimError(
      "orbit: this run leased no GPUs; request GPUs for the run to use --gpus in its containers",
    );
  if (cfg.gpuMode === "cdi")
    return cfg.gpuIds.flatMap((id) => ["--device", `nvidia.com/gpu=${id}`]);
  return ["--gpus", `"device=${cfg.gpuIds.join(",")}"`];
}

/**
 * Rewrite a docker command line for a process run. Pure except for `imagePath`, which is asked for
 * the image's PATH when the Agent CLI must be put on a PATH the caller did not set.
 */
export function rewriteDockerArgs(
  args: string[],
  cfg: ShimConfig,
  imagePath: (image: string) => string | null = () => null,
): string[] {
  const ci = commandIndex(args);
  let cmd = args[ci];
  let end = ci + 1;
  if ((cmd === "container" || cmd === "image" || cmd === "buildx") && args[ci + 1]) {
    cmd = `${cmd} ${args[ci + 1]}`;
    end = ci + 2;
  }
  const head = args.slice(0, end);
  const rest = args.slice(end);

  if (cmd === "build" || cmd === "image build" || cmd === "buildx build") {
    const hasNet = rest.some((a) => a === "--network" || a.startsWith("--network="));
    return cfg.hostNetwork && !hasNet ? [...head, "--network", "host", ...rest] : args;
  }
  if (!["run", "create", "container run", "container create"].includes(cmd ?? "")) return args;

  const out: string[] = [];
  let pathSet = false;
  let i = 0;
  let image: string | null = null;
  const envValue = (v: string) => {
    if (cfg.auth && v.startsWith("PATH=")) {
      pathSet = true;
      return `PATH=${containerPath(cfg.auth.pathDirs, v.slice(5))}`;
    }
    return v;
  };
  for (; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      image = a;
      break;
    }
    if (a === "--gpus") {
      out.push(...gpuArgs(cfg));
      i++;
      continue;
    }
    if (a.startsWith("--gpus=")) {
      out.push(...gpuArgs(cfg));
      continue;
    }
    if (a === "-e" || a === "--env") {
      out.push(a, envValue(rest[i + 1] ?? ""));
      i++;
      continue;
    }
    if (a.startsWith("--env=")) {
      out.push(`--env=${envValue(a.slice(6))}`);
      continue;
    }
    if (a.startsWith("-e") && !a.startsWith("--")) {
      out.push(`-e${envValue(a.slice(2))}`);
      continue;
    }
    out.push(a);
    if (a.startsWith("--")) {
      if (!a.includes("=") && !RUN_BOOL.has(a)) out.push(rest[++i] ?? "");
    } else if (a.length === 2) {
      if (!SHORT_BOOL.has(a.slice(1))) out.push(rest[++i] ?? "");
    }
    // Other short clusters: all boolean (`-it`) or a value attached (`-p8080:80`).
  }
  if (image === null && i < rest.length) image = rest[i] ?? null;

  const inject = [
    "--label",
    `${LABEL_PARENT}=${cfg.runId}`,
    "--label",
    `${LABEL_HOME}=${cfg.homeLabel}`,
  ];
  const agentHome: string[] = [];
  if (cfg.auth) {
    for (const m of cfg.auth.mounts) inject.push("-v", `${m.source}:${m.target}:${m.mode}`);
    inject.push("-v", `${cfg.auth.agentDir}:${AGENT_HOME}`);
    for (const [k, v] of Object.entries(cfg.auth.env)) {
      const target = k === "CODEX_HOME" || k === "CLAUDE_CONFIG_DIR" ? agentHome : inject;
      target.push("-e", `${k}=${v}`);
    }
    if (cfg.auth.envFile) inject.push("--env-file", cfg.auth.envFile);
    if (!pathSet && image && cfg.auth.pathDirs.length > 0)
      inject.push("-e", `PATH=${containerPath(cfg.auth.pathDirs, imagePath(image))}`);
  }
  return [...head, ...inject, ...out, ...agentHome, ...rest.slice(i)];
}

/** Entry point: `orbit __docker-shim <config.json> <docker args...>`. */
export function shimMain(configFile: string, args: string[]): void {
  const cfg = JSON.parse(readFileSync(configFile, "utf8")) as ShimConfig;
  let argv: string[];
  try {
    argv = rewriteDockerArgs(args, cfg, (image) => {
      const r = spawnSync(
        cfg.realDocker,
        ["image", "inspect", "--format", "{{json .Config.Env}}", image],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      const env = (JSON.parse(r.stdout || "null") as string[] | null) ?? [];
      return env.find((e) => e.startsWith("PATH="))?.slice(5) ?? null;
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(125);
  }
  const child = spawn(cfg.realDocker, argv, {
    stdio: "inherit",
    env: { ...process.env, DOCKER_CONFIG: process.env.DOCKER_CONFIG || cfg.dockerConfig },
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(sig, () => child.kill(sig));
  child.on("error", (e) => {
    process.stderr.write(`orbit docker shim: ${e.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
}
