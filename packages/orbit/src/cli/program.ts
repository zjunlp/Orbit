import { collect, num } from "./options.ts";
import {
  addRunOptions,
  buildSpec,
  expandGrid,
  preflight,
  type RunOpts,
  smokeRun,
  substitute,
  waitAll,
} from "./run.ts";

export { expandGrid, substitute } from "./run.ts";

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, Option } from "commander";
import { type OrbitClient, tryConnect } from "../client/index.ts";
import {
  ensureHome,
  type OrbitPaths,
  orbitPaths,
  readConfig,
  writeConfig,
} from "../config/paths.ts";
import { isTerminal, type Run, type RunSpecInput } from "../contracts/index.ts";
import { acquireProcessLock, ProcessLockError } from "../lib/lock.ts";
import { VERSION } from "../lib/version.ts";
import { registerAgent } from "./agent.ts";
import { registerAuth, registerNotify } from "./auth.ts";
import { registerBench } from "./bench.ts";
import { registerCluster } from "./cluster.ts";
import { confirmTyped } from "./confirm.ts";
import { registerFeishu } from "./feishu.ts";
import {
  fmtBytes,
  formatDoctor,
  formatFolders,
  formatLedger,
  formatRun,
  formatRuns,
} from "./format.ts";
import { registerPlugin } from "./plugin.ts";
import { registerTrajectory } from "./trajectory.ts";

export interface ProgramDeps {
  /** Run the daemon in the foreground; provided by the composition root (src/bin.ts). */
  runDaemon(paths: OrbitPaths, port?: number): Promise<void>;
}

/** Connect to the local daemon, starting a detached one when none is running. */
export async function connect(p: OrbitPaths): Promise<OrbitClient> {
  const existing = await tryConnect(p);
  if (existing) return existing;
  ensureHome(p);
  let release: (() => void) | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      release = acquireProcessLock(join(p.home, "daemon.spawn.lock"));
      break;
    } catch (e) {
      if (!(e instanceof ProcessLockError)) throw e;
      await new Promise((r) => setTimeout(r, 100));
      const client = await tryConnect(p);
      if (client) return client;
    }
  }
  if (!release) throw new Error(`daemon startup is busy; see ${p.daemonLog}`);
  try {
    const existing = await tryConnect(p);
    if (existing) return existing;
    const entry = process.argv[1];
    if (!entry) throw new Error("cannot locate the orbit entrypoint to start the daemon");
    const log = openSync(p.daemonLog, "a");
    let spawnError: Error | undefined;
    try {
      const child = spawn(process.execPath, [...process.execArgv, entry, "daemon"], {
        detached: true,
        stdio: ["ignore", log, log],
        env: process.env,
      });
      child.once("error", (e) => {
        spawnError = e;
      });
      child.unref();
    } finally {
      closeSync(log);
    }
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (spawnError) throw spawnError;
      const client = await tryConnect(p);
      if (client) return client;
    }
    throw new Error(`daemon did not start; see ${p.daemonLog}`);
  } finally {
    release();
  }
}

export function createProgram(deps: ProgramDeps, paths: OrbitPaths = orbitPaths()): Command {
  const program = new Command()
    .name("orbit")
    .description("Run, isolate and record experiments for Codex / Claude Code")
    .version(VERSION)
    .enablePositionalOptions();
  const client = () => connect(paths);
  registerTrajectory(program, client);
  const print = (json: boolean | undefined, value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());

  program
    .command("daemon")
    .description("run the node daemon in the foreground (the CLI starts it automatically)")
    .option("-p, --port <port>", "listen port on 127.0.0.1", num)
    .option("--stop", "stop the running daemon (runs keep going and are reattached on restart)")
    .action(async (opts: { port?: number; stop?: boolean }) => {
      if (!opts.stop) return deps.runDaemon(paths, opts.port);
      // The pid the daemon reports itself: a stale daemon.json may name a reused pid.
      const live = await tryConnect(paths);
      if (!live) return console.log("daemon is not running");
      const { pid } = await live.health();
      process.kill(pid, "SIGTERM");
      console.log(`stopped daemon pid ${pid}`);
    });

  addRunOptions(
    program
      .command("run")
      .description("run a command in a container: orbit run [options] -- <command...>")
      .argument("<command...>")
      .passThroughOptions(),
  ).action(async (command: string[], o: RunOpts) => {
    const c = await client();
    const spec = await buildSpec(o, command);
    if (!(await preflight(c, spec, o))) return;
    if (o.smoke) {
      const parentId = await smokeRun(c, spec, o);
      if (!parentId) return;
      spec.parentId = parentId;
    }
    const run = await c.submit(spec, o.folder);
    if (o.wait) return waitAll(c, [run.id], Boolean(o.json), true);
    print(o.json, run, () => `${run.id}  ${run.state}${run.reason ? ` (${run.reason})` : ""}`);
  });

  addRunOptions(
    program
      .command("sweep")
      .description("submit one run per parameter combination; {key} in the command is substituted")
      .option("-p, --param <KEY=V1,V2,...>", "parameter values (repeatable, required)", collect, [])
      .argument("<command...>")
      .passThroughOptions(),
  ).action(async (command: string[], o: RunOpts & { param: string[] }) => {
    const grid = expandGrid(o.param);
    const unused = Object.keys(grid[0] ?? {}).filter(
      (k) => !command.some((a) => a.includes(`{${k}}`)),
    );
    if (unused.length)
      throw new Error(`--param ${unused.join(", ")} not used as {key} in the command`);
    const c = await client();
    const group =
      o.group ?? o.name ?? `sweep-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
    const specs: RunSpecInput[] = [];
    for (const params of grid) {
      const suffix = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      specs.push(
        await buildSpec(
          { ...o, group, name: `${o.name ?? group}[${suffix}]` },
          substitute(command, params),
          params,
        ),
      );
    }
    // Every combination shares the settings that are checked; the first stands for all of them.
    const first = specs[0] as RunSpecInput;
    if (!(await preflight(c, first, o))) return;
    const parentId = o.smoke ? await smokeRun(c, first, o, first.params) : undefined;
    if (parentId === null) return;
    const runs: Run[] = [];
    for (const spec of specs) runs.push(await c.submit({ ...spec, parentId }, o.folder));
    if (o.wait)
      return waitAll(
        c,
        runs.map((r) => r.id),
        Boolean(o.json),
      );
    print(o.json, runs, () => `group ${group}\n${formatRuns(runs)}`);
  });

  program
    .command("resume <id>")
    .description(
      "restore a checkpoint into a new standalone run and continue its native Agent session",
    )
    .option(
      "--command <shell>",
      "run this shell command instead (e.g. inspect files without calling a model)",
    )
    .option("-w, --wait", "wait for completion")
    .option("--json", "print JSON")
    .action(async (id: string, o: { command?: string; wait?: boolean; json?: boolean }) => {
      const c = await client();
      const run = await c.resume(id, {
        command: o.command === undefined ? undefined : ["sh", "-c", o.command],
      });
      if (o.wait) return waitAll(c, [run.id], Boolean(o.json));
      print(o.json, run, () => formatRun(run));
    });

  program
    .command("ps")
    .description("list runs (active by default)")
    .option("-a, --all", "include finished runs")
    .option("-g, --group <group>", "only this group")
    .option("-f, --folder <path>", "only this folder and its subfolders")
    .option("-l, --limit <n>", "max runs", num, 50)
    .option("--json", "print JSON")
    .action(
      async (o: {
        all?: boolean;
        group?: string;
        folder?: string;
        limit: number;
        json?: boolean;
      }) => {
        const states =
          o.all || o.group || o.folder ? undefined : (["queued", "starting", "running"] as const);
        const runs = await (await client()).list({
          states: states ? [...states] : undefined,
          group: o.group,
          folder: o.folder,
          limit: o.limit,
        });
        print(o.json, runs, () => formatRuns(runs));
      },
    );

  program
    .command("mv")
    .description('file runs or bench jobs in a folder (a job takes its runs along); "" for none')
    .argument("<ids...>", "run or bench job ids, then the folder")
    .action(async (args: string[]) => {
      const folder = args.at(-1) ?? "";
      const ids = args.slice(0, -1);
      if (ids.length === 0) throw new Error("usage: orbit mv <id...> <folder>");
      const r = await (await client()).move(ids, folder.replace(/\/+$/, ""));
      console.log(
        `moved ${r.runs.length} run(s)${r.jobs.length ? ` and ${r.jobs.length} job(s)` : ""} to ${folder || "(no folder)"}`,
      );
    });

  program
    .command("folders")
    .description("list folders with their runs, jobs and size (subfolders included)")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const fs = await (await client()).folders();
      print(o.json, fs, () => formatFolders(fs));
    });

  program
    .command("export")
    .description("copy a folder's runs (files and records) and jobs into a new directory")
    .argument("<folder>")
    .argument("<dest>")
    .option("--json", "print JSON")
    .action(async (folder: string, dest: string, o: { json?: boolean }) => {
      const r = await (await client()).exportFolder(folder.replace(/\/+$/, ""), resolve(dest));
      print(o.json, r, () =>
        [
          `exported ${r.runs} run(s) and ${r.jobs} job(s), ${fmtBytes(r.bytes)}, to ${r.dest}`,
          ...r.skipped.map((x) => `skipped ${x}`),
        ].join("\n"),
      );
    });

  program
    .command("config")
    .description(
      "show or set where Orbit keeps run data (takes effect after `orbit daemon --stop`)",
    )
    .argument("[key]", "data")
    .argument("[value]", "absolute directory on a large disk")
    .action((key: string | undefined, value: string | undefined) => {
      if (!key) {
        console.log(`home  ${paths.home}  (database, profiles, config)`);
        console.log(`data  ${paths.data}  (runs, staging; from ${paths.dataSource})`);
        return;
      }
      if (key !== "data") throw new Error(`unknown config key ${key} (data)`);
      if (!value) return console.log(paths.data);
      const dir = resolve(value);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeConfig(paths.config, { ...readConfig(paths.config), dataDir: dir });
      const moved = existsSync(paths.runs) && readdirSync(paths.runs).length > 0;
      console.log(`data directory set to ${dir}`);
      if (process.env.ORBIT_DATA) console.log("note: ORBIT_DATA is set and still takes precedence");
      if (moved && resolve(paths.data) !== dir)
        console.log(
          `existing runs stay in ${paths.data}: stop the daemon (orbit daemon --stop), move\n` +
            `  ${join(paths.data, "runs")}, ${join(paths.data, "bench")} and ${join(paths.data, "cache")} into ${dir}, then run any orbit command`,
        );
      else console.log("restart the daemon to use it: orbit daemon --stop");
    });

  program
    .command("show")
    .description("show a run with its latest metrics")
    .argument("<id>")
    .option("--json", "print JSON")
    .action(async (id: string, o: { json?: boolean }) => {
      const c = await client();
      const [run, metrics] = await Promise.all([c.get(id), c.metrics(id)]);
      print(o.json, { run, metrics: metrics.summary }, () => formatRun(run, metrics.summary));
    });

  program
    .command("logs")
    .description("print run logs")
    .argument("<id>")
    .option("-f, --follow", "keep printing until the run ends")
    .option("--tail <bytes>", "start this many bytes before the end", num)
    .action(async (id: string, o: { follow?: boolean; tail?: number }) => {
      const c = await client();
      let offset = o.tail ? -o.tail : 0;
      for (;;) {
        const chunk = await c.logs(id, offset);
        if (chunk.text) process.stdout.write(chunk.text);
        offset = chunk.next;
        if (chunk.next > chunk.offset && chunk.next < chunk.size) continue;
        if (!o.follow || chunk.eof) break;
        const run = await c.get(id);
        if (isTerminal(run.state) && run.cleanup !== "pending") {
          const last = await c.logs(id, offset);
          process.stdout.write(last.text);
          if (last.next >= last.size) break;
          offset = last.next;
          continue;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    });

  program
    .command("wait")
    .description("wait for runs to finish; exits 1 if any did not succeed")
    .argument("[ids...]")
    .option("-g, --group <group>", "wait for every run in this group")
    .option("--json", "print JSON")
    .action(async (ids: string[], o: { group?: string; json?: boolean }) => {
      const c = await client();
      if (o.group)
        ids = [...ids, ...(await c.list({ group: o.group, limit: 10_000 })).map((r) => r.id)];
      if (ids.length === 0) throw new Error("give run ids or --group");
      await waitAll(c, [...new Set(ids)], Boolean(o.json));
    });

  program
    .command("cancel")
    .description("cancel queued or running runs")
    .argument("<ids...>")
    .action(async (ids: string[]) => {
      const c = await client();
      for (const id of ids) {
        const r = await c.cancel(id);
        console.log(`${r.id}  ${r.state}`);
        if (r.spec.tags.batch_size)
          console.log(
            `Stopped unfinished work in the ${r.spec.tags.batch_size}-episode batch; completed evidence is still verified.`,
          );
      }
    });

  program
    .command("rm")
    .description(
      "permanently delete finished runs (records, logs, outputs); asks you to type the id or group",
    )
    .argument("[ids...]")
    .option("-g, --group <group>", "every run of this group")
    .option("-y, --yes", "skip the typed confirmation (required without a terminal)")
    .option("--json", "print JSON")
    .action(async (ids: string[], o: { group?: string; yes?: boolean; json?: boolean }) => {
      const c = await client();
      const targets = [...ids];
      if (o.group)
        targets.push(...(await c.list({ group: o.group, limit: 10_000 })).map((r) => r.id));
      if (targets.length === 0) throw new Error("give run ids or --group");
      const expected =
        o.group && ids.length === 0
          ? o.group
          : targets.length === 1
            ? (targets[0] as string)
            : `delete ${targets.length} runs`;
      await confirmTyped(
        `delete ${targets.length} run(s)${o.group ? ` of group ${o.group}` : ""}`,
        expected,
        o.yes,
      );
      const r = await c.deleteRuns(targets);
      print(o.json, r, () =>
        [
          `deleted ${r.deleted.length} run(s)`,
          ...r.leftovers.map((d) => `could not remove all files of ${d}`),
        ].join("\n"),
      );
    });

  program
    .command("note")
    .description(
      "attach an analysis note to a run (text, or - for stdin); replaces the previous note",
    )
    .argument("<id>")
    .argument("<text>")
    .action(async (id: string, text: string) => {
      const note = text === "-" ? readFileSync(0, "utf8") : text;
      await (await client()).note(id, note);
      console.log(`noted ${id}`);
    });

  program
    .command("resources")
    .alias("ledger")
    .description(
      "show GPUs, devices, CPU, memory, leases and the queue on this node and its workers",
    )
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const l = await (await client()).ledger();
      print(o.json, l, () => formatLedger(l));
    });

  program
    .command("doctor")
    .description("check docker, nvidia-smi, git, node and the Agent CLIs")
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const r = await (await client()).doctor();
      print(o.json, r, () => formatDoctor(r));
      if (!r.ok) process.exitCode = 1;
    });

  program
    .command("reconcile")
    .description(
      "remove Docker leftovers of finished runs and release leaked leases now (the daemon also does it every 10 min)",
    )
    .option("--json", "print JSON")
    .action(async (o: { json?: boolean }) => {
      const r = await (await client()).reconcile();
      print(o.json, r, () =>
        r.skipped
          ? "docker did not answer; nothing was decided"
          : [
              `removed ${r.removed.length} leftover(s), released ${r.released.length} lease(s)`,
              ...r.removed.map((x) => `  - ${x}`),
              ...r.failed.map((x) => `  ! failed: ${x}`),
            ].join("\n"),
      );
      if (r.failed.length || r.skipped) process.exitCode = 1;
    });

  registerAgent(program, client, print);
  registerAuth(program, client, print);
  registerNotify(program, client, print);
  registerFeishu(program, client, print);
  registerBench(program, client, print);
  registerCluster(program, client, print);
  registerPlugin(program);

  program
    .command("web [id]")
    .description("print the local Web UI login URL (optionally deep-linked to a run)")
    .addOption(new Option("--open", "open it in the default browser"))
    .action(async (id: string | undefined, o: { open?: boolean }) => {
      const c = await client();
      const next = id ? `&next=${encodeURIComponent(`/runs/${id}`)}` : "";
      console.log(`${c.info.url}/login?token=${c.info.token}${next}`);
      if (o.open) {
        const { code } = await c.loginCode();
        const url = `${c.info.url}/login?code=${code}${next}`;
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" })
          .on("error", () => {})
          .unref();
      }
    });

  return program;
}
