import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Argument, type Command } from "commander";
import { exec } from "../lib/exec.ts";
import { VERSION } from "../lib/version.ts";

type Agent = "claude" | "codex" | "dsh" | "pi";
const labels: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek Harness",
  pi: "pi coding agent",
};

async function run(agent: Agent, args: string[], probe = false): Promise<void> {
  if (!probe) console.log(`${agent} ${args.join(" ")}`);
  const result = await exec(agent, args, { timeoutMs: probe ? 15_000 : 300_000 });
  if (!probe || result.code !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.code !== 0) {
    throw new Error(
      result.code === 127
        ? `${labels[agent]} is required; install it and rerun this command`
        : probe
          ? `${labels[agent]} does not support the required plugin command; upgrade it and retry`
          : `${labels[agent]} exited with ${result.code}; fix the error above and rerun this command`,
    );
  }
}

export function registerPlugin(program: Command): void {
  program
    .command("plugin")
    .description("manage Orbit skills for Claude Code, Codex, DeepSeek Harness and pi")
    .command("install")
    .description("install Orbit skills using the agent's native plugin/package manager")
    .addArgument(
      new Argument("[agent]", "target agent").choices(Object.keys(labels)).default("claude"),
    )
    .option("--source <source>", "marketplace repo/path (Claude/Codex), npm package/path (dsh/pi)")
    .option("--profile <name>", "required dsh profile, e.g. headless")
    .action(async (agent: Agent, opts: { source?: string; profile?: string }) => {
      if (agent === "dsh") {
        if (!opts.profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(opts.profile)) {
          throw new Error("dsh requires --profile <name>, e.g. --profile headless");
        }
        if (opts.profile === "desktop") throw new Error("dsh reserves the desktop profile");
        if (opts.profile === "sdk-minimal") {
          throw new Error(
            "dsh sdk-minimal has no skills service; use a profile based on dsh-base, e.g. headless",
          );
        }
      } else if (opts.profile !== undefined) {
        throw new Error("--profile is only supported for dsh");
      }
      const marketplace = agent === "claude" || agent === "codex";
      const input = opts.source ?? (marketplace ? "zjunlp/Orbit" : `@zjunlp/orbit@${VERSION}`);
      if (!input.trim() || input.startsWith("-")) throw new Error("Invalid plugin source");
      const local = existsSync(input);
      if (!local && /^(?:\.{1,2}\/|\/|~\/)/.test(input)) {
        throw new Error(`Plugin source does not exist: ${input}`);
      }
      const source = local ? resolve(input) : input;
      if (local && agent !== "dsh" && !statSync(source).isDirectory()) {
        throw new Error(`${labels[agent]} needs a source directory; unpack the tarball first`);
      }

      if (agent === "claude" || agent === "codex") {
        const verb = agent === "claude" ? "install" : "add";
        await run(agent, ["plugin", verb, "--help"], true);
        await run(agent, ["plugin", "marketplace", "add", source]);
        await run(agent, [
          "plugin",
          verb,
          "orbit@orbit",
          ...(agent === "claude" ? ["--scope", "user"] : []),
        ]);
      } else if (agent === "dsh") {
        await run(agent, ["--version"], true);
        // pnpm's default directory links cannot resolve host providers outside the profile.
        await run(agent, [
          "plugin",
          "--profile",
          opts.profile as string,
          "add",
          local ? `file:${source}` : source,
        ]);
      } else {
        await run(agent, ["install", "--help"], true);
        await run(agent, [
          "install",
          local || source.startsWith("npm:") ? source : `npm:${source}`,
        ]);
      }
      console.log(
        `Orbit plugin installed. Restart ${labels[agent]}${opts.profile ? ` (profile ${opts.profile})` : ""} to load orbit, orbit-bench and orbit-evolve.`,
      );
    });
}
