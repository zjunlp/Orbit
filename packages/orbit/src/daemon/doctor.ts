import { type OrbitPaths, privateStateCheck } from "../config/paths.ts";
import type { AgentInfo, DoctorCheck, DoctorReport } from "../contracts/index.ts";
import type { AgentRegistry } from "../harness/registry.ts";
import { exec } from "../lib/exec.ts";
import { diskCheck as disk } from "../resources/disk.ts";

async function tool(name: string, cmd: string, args: string[]): Promise<DoctorCheck> {
  const r = await exec(cmd, args);
  const out = (r.code === 0 ? r.stdout : r.stderr).trim().split("\n")[0] ?? "";
  return { name, ok: r.code === 0, detail: out || `exit ${r.code}`, warn: false };
}

/**
 * Agent CLIs that mount from this machine. Missing ones only matter for runs that use them, so the
 * check never fails: an `install` Agent needs no host binary at all.
 */
async function agentCheck(info: AgentInfo): Promise<DoctorCheck> {
  const install = info.definition.install;
  return {
    name: info.definition.name,
    ok: true,
    warn: false,
    detail: info.available
      ? info.detail
      : `${info.detail}; runs with this Agent fail on this node${install.kind === "host" ? " (or install it and restart)" : ""}`,
  };
}

/** Where Docker keeps images and container layers (often the system disk). */
async function dockerRoot(): Promise<DoctorCheck | null> {
  const r = await exec("docker", ["info", "--format", "{{.DockerRootDir}}"]);
  const dir = r.stdout.trim();
  if (r.code !== 0 || !dir.startsWith("/")) return null;
  return disk("docker data", dir, "large images fill it (docker `data-root`)");
}

export async function runDoctor(paths: OrbitPaths, agents?: AgentRegistry): Promise<DoctorReport> {
  const agentChecks = agents
    ? await Promise.all(
        (await Promise.all(agents.list().map((d) => agents.info(d)))).map(agentCheck),
      )
    : [];
  const checks = await Promise.all([
    Promise.resolve(privateStateCheck(paths)),
    Promise.resolve<DoctorCheck>({ name: "node", ok: true, warn: false, detail: process.version }),
    disk(
      "orbit data",
      paths.data,
      `move runs to a large disk with \`orbit config data <dir>\` (now: ${paths.dataSource})`,
    ),
    tool("git", "git", ["--version"]),
    tool("docker", "docker", ["version", "--format", "server {{.Server.Version}}"]),
    tool("nvidia-smi", "nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"]),
    ...agentChecks,
    dockerRoot(),
  ]);
  const all = checks.filter((c): c is DoctorCheck => c !== null);
  return { ok: all.every((c) => c.ok), checks: all };
}
