import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, Run, RunCheckpoint, RunSpecInput } from "../contracts/index.ts";
import * as docker from "../executor/docker.ts";
import { finishHarness, resumeAgentCommand } from "../harness/index.ts";
import { builtinRegistry } from "../harness/registry.ts";
import { nowIso } from "../lib/ids.ts";
import { dirBytes } from "../records/index.ts";
import { runAgentSession } from "../sessions/index.ts";
import type { RunContext } from "./context.ts";
import { UserError } from "./errors.ts";

type Context = Pick<RunContext, "dirs" | "homeLabel" | "mustGet" | "save" | "redactor">;

export const checkpointTag = (id: string) => `orbit-checkpoint/${id}:saved`;
export const checkpointDir = (ctx: Pick<Context, "dirs">, id: string) =>
  join(ctx.dirs(id).root, "checkpoint");

export async function capture(
  ctx: Context,
  id: string,
  containerId: string,
  executionMin?: number,
): Promise<void> {
  const run = ctx.mustGet(id);
  if (!run.spec.checkpoint || run.checkpoint) return;
  const root = checkpointDir(ctx, id);
  const tag = checkpointTag(id);
  let committed = false;
  let checkpoint: RunCheckpoint;
  try {
    const status = await docker.inspectContainer(containerId);
    if (!status || status.running) throw new Error("checkpoint requires a stopped container");
    const limit = run.spec.checkpoint.maxSizeGB * 1024 ** 3;
    const layerBytes = await docker.writableSize(containerId);
    if (layerBytes > limit)
      throw new Error("container writable layer exceeds checkpoint size limit");
    const dirs = ctx.dirs(id);
    let estimatedBytes = layerBytes;
    for (const path of [
      dirs.orbit,
      ...(run.code ? [dirs.workspace] : []),
      dirs.diff,
      ...(run.spec.after?.copy ?? []).map((c) => c.source),
    ]) {
      estimatedBytes += (await dirBytes(path)) ?? 0;
      if (estimatedBytes > limit) throw new Error("checkpoint files exceed checkpoint size limit");
    }
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const [src, dest] of [
      ["/orbit", join(root, "orbit")],
      ...(run.code ? [["/workspace", join(root, "workspace")]] : []),
    ]) {
      const error = await docker.copyFromContainer(containerId, src as string, dest as string);
      if (error) throw new Error(`checkpoint file copy failed: ${error}`);
    }
    finishHarness(null, join(root, "orbit", "agent"));
    rmSync(join(root, "orbit", "phases"), { recursive: true, force: true });
    if (existsSync(ctx.dirs(id).diff))
      await cp(ctx.dirs(id).diff, join(root, "code.diff"), { preserveTimestamps: true });
    for (const [i, c] of (run.spec.after?.copy ?? []).entries()) {
      const dest = join(root, "after", String(i));
      mkdirSync(join(root, "after"), { recursive: true });
      await cp(c.source, dest, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
    }
    const filesBytes = await dirBytes(root);
    if (filesBytes === null || layerBytes + filesBytes > limit)
      throw new Error("checkpoint files exceed checkpoint size limit");
    const session = await runAgentSession(join(root, "orbit", "agent"));
    const clearEnv = [
      ...new Set([
        ...run.spec.passEnv,
        "OPENAI_API_KEY",
        "ORBIT_RELAY_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ]),
    ];
    const imageId = await docker.commitCheckpoint(containerId, tag, clearEnv, {
      "orbit.checkpoint": id,
      [docker.LABEL_HOME]: ctx.homeLabel,
    });
    committed = true;
    checkpoint = {
      state: "ready",
      imageId,
      sizeBytes: layerBytes + filesBytes,
      executionMin,
      session,
      createdAt: nowIso(),
      reason: null,
    };
  } catch (e) {
    if (committed) await docker.removeCheckpoint(tag);
    rmSync(root, { recursive: true, force: true });
    checkpoint = {
      state: "failed",
      imageId: null,
      sizeBytes: null,
      session: null,
      createdAt: nowIso(),
      reason: ctx.redactor(run).apply((e as Error).message),
    };
  }
  const fresh = ctx.mustGet(id);
  fresh.checkpoint = checkpoint;
  ctx.save(
    fresh,
    "checkpoint",
    checkpoint.state === "ready"
      ? `saved ${checkpoint.sizeBytes} bytes; filesystem and session only`
      : `checkpoint failed: ${checkpoint.reason}`,
  );
}

/** The Agent a run used: from its auth profile's harness, else the command's own program name. */
function resumeDef(
  run: Run,
  agents?: { get(name: string): AgentDefinition | null },
): AgentDefinition {
  const session = run.checkpoint?.session;
  const name = session?.harness ?? run.spec.command[0] ?? "";
  const def = (agents ?? builtinRegistry()).get(name);
  if (!def) throw new UserError(`Agent ${name || "of this run"} is not registered on this node`);
  return def;
}

export function resumeSpec(
  run: Run,
  command?: string[],
  agents?: { get(name: string): AgentDefinition | null },
): RunSpecInput {
  const checkpoint = run.checkpoint;
  if (checkpoint?.state !== "ready" || !checkpoint.imageId)
    throw new UserError("run has no usable checkpoint");
  const elapsed =
    checkpoint.executionMin ??
    (run.startedAt && run.endedAt
      ? Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60_000
      : 0);
  const remaining = run.spec.timeoutMin === undefined ? undefined : run.spec.timeoutMin - elapsed;
  if (remaining !== undefined && remaining <= 0)
    throw new UserError("run exhausted its execution time budget");
  if (!command && !checkpoint.session)
    throw new UserError(
      "checkpoint has no native Agent session; provide a command to restore files",
    );
  let nextCommand = command;
  if (!nextCommand) {
    const def = resumeDef(run, agents);
    nextCommand = resumeAgentCommand(
      def,
      // The method's model and effort are baked into the command; a resume only needs the id.
      {},
      checkpoint.session as NonNullable<typeof checkpoint.session>,
      def.command.mcp.kind === "claude-json" &&
        run.spec.command.some(
          (arg) =>
            def.command.mcp.kind === "claude-json" &&
            (arg === def.command.mcp.flag || arg.startsWith(`${def.command.mcp.flag}=`)),
        ),
    );
  }
  return {
    ...run.spec,
    image: checkpoint.imageId,
    dockerfile: undefined,
    project: undefined,
    agent: undefined,
    agentBundle: undefined,
    command: nextCommand,
    parentId: run.id,
    name: `Resume ${run.spec.name ?? run.id}`.slice(0, 200),
    group: undefined,
    tags: { resumedFrom: run.id },
    params: {},
    ...(command ? { after: undefined, hooks: [] } : {}),
    resources: { ...run.spec.resources, node: run.node },
    timeoutMin: remaining,
  };
}

/** Copy immutable checkpoint files into a new run before it becomes visible to the scheduler. */
export async function restore(ctx: Pick<Context, "dirs">, source: Run, run: Run): Promise<void> {
  const root = checkpointDir(ctx, source.id);
  const dirs = ctx.dirs(run.id);
  const paths = [["orbit", dirs.orbit], ...(source.code ? [["workspace", dirs.workspace]] : [])];
  for (const [from] of paths)
    if (!statSync(join(root, from as string), { throwIfNoEntry: false })?.isDirectory())
      throw new UserError(`checkpoint files missing: ${from}`);
  for (const [from, dest] of paths) {
    const src = join(root, from as string);
    await cp(src, dest as string, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }
  if (existsSync(join(root, "code.diff")))
    await cp(join(root, "code.diff"), dirs.diff, { preserveTimestamps: true });
  if (source.code) run.code = structuredClone(source.code);
  if (run.spec.after)
    run.spec.after.copy = run.spec.after.copy.map((c, i) => ({
      ...c,
      source: join(dirs.root, "after-inputs", String(i)),
    }));
  for (const [i, c] of (run.spec.after?.copy ?? []).entries()) {
    mkdirSync(join(dirs.root, "after-inputs"), { recursive: true });
    await cp(join(root, "after", String(i)), c.source, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }
}
