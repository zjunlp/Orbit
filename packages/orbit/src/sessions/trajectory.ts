import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { AtifSource, AtifTrajectory, type Run } from "../contracts/index.ts";
import type { TrajectoryConversion } from "./atif.ts";
import { type ClaudeSubagentInput, convertClaudeTrajectory } from "./claude.ts";
import { convertCodexTrajectory } from "./codex.ts";
import { findRunSession, MAX_SESSION_BYTES, readSessionInput } from "./files.ts";
import { importAtif } from "./import.ts";
import { nativeStatus } from "./status.ts";

export async function convertSessionFile(
  file: string,
  harness: "codex" | "claude-code",
  root = dirname(file),
  existingInput?: string,
): Promise<TrajectoryConversion | null> {
  const input = existingInput ?? (await readSessionInput(file, root));
  if (!input.trim()) return null;
  const sourcePath = relative(root, file);
  const options = {
    sourcePath,
    sessionId:
      harness === "claude-code"
        ? file
            .split("/")
            .pop()
            ?.replace(/\.jsonl$/, "")
        : undefined,
  };
  try {
    if (harness === "codex") return convertCodexTrajectory(input, options);
    const children: ClaudeSubagentInput[] = [];
    const subdir = join(file.slice(0, -6), "subagents");
    const entries = await readdir(subdir, { withFileTypes: true }).catch(() => []);
    let bytes = Buffer.byteLength(input);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const childFile = join(subdir, entry.name);
      const child = await readSessionInput(childFile, root, MAX_SESSION_BYTES - bytes);
      bytes += Buffer.byteLength(child);
      const agentId = entry.name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      let toolUseId: string | undefined;
      try {
        const meta = JSON.parse(
          await readSessionInput(childFile.replace(/\.jsonl$/, ".meta.json"), root, 1024 * 1024),
        );
        if (typeof meta.toolUseId === "string") toolUseId = meta.toolUseId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      children.push({ input: child, agentId, toolUseId, sourcePath: relative(root, childFile) });
    }
    return convertClaudeTrajectory(input, { ...options, subagents: children });
  } catch (error) {
    if (
      error instanceof Error &&
      /contains no (trajectory|convertible conversation) steps/.test(error.message)
    )
      return null;
    throw error;
  }
}

export async function readAgentEvidence(agentDir: string) {
  const source = await findRunSession(agentDir);
  if (!source) return null;
  const input = await readSessionInput(source.file, agentDir);
  return { ...source, input, status: nativeStatus(input, source.harness) };
}

export async function loadAgentTrajectory(agentDir: string) {
  const source = await readAgentEvidence(agentDir);
  if (!source) return null;
  const result = await convertSessionFile(source.file, source.harness, agentDir, source.input);
  if (!result) return null;
  const orbit = result.trajectory.extra?.orbit;
  if (orbit) orbit.metadata = { ...orbit.metadata, model_status: source.status };
  return { ...result, file: source.file };
}

export async function loadAtifTrajectory(output: string, source: AtifSource) {
  for (const directory of [dirname(output), output]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("unsafe ATIF output directory");
  }
  const checked = AtifSource.parse(source);
  const file = join(output, checked.path);
  const input = await readSessionInput(file, output);
  const result = importAtif(input, checked);
  const paths = new Map<string, string>();
  const assets = new Map<string, TrajectoryConversion["media"][number]>();
  let bytes = Buffer.byteLength(input);
  for (const asset of result.media) {
    let data: Buffer;
    const limit = Math.min(32 * 1024 * 1024, MAX_SESSION_BYTES - bytes);
    if (asset.base64 !== undefined) {
      data = Buffer.from(asset.base64, "base64");
      if (data.length > limit) throw new Error("ATIF media exceeds import limit");
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(asset.sourcePath))
        throw new Error("remote ATIF media must be collected locally before import");
      const sourceFile = asset.sourcePath.startsWith("/orbit/output/")
        ? join(output, asset.sourcePath.slice("/orbit/output/".length))
        : resolve(dirname(file), asset.sourcePath);
      data = Buffer.from(await readSessionInput(sourceFile, output, limit, "base64"), "base64");
    }
    bytes += data.length;
    const path = `media/${createHash("sha256").update(data).digest("hex")}.${asset.path.split(".").pop()}`;
    paths.set(asset.path, path);
    assets.set(path, { path, mediaType: asset.mediaType, base64: data.toString("base64") });
  }
  const visit = (t: AtifTrajectory) => {
    const content = (parts: AtifTrajectory["steps"][number]["message"]) => {
      if (typeof parts !== "string")
        for (const part of parts)
          if (part.type !== "text")
            part.source.path = paths.get(part.source.path) ?? part.source.path;
    };
    for (const step of t.steps) {
      content(step.message);
      for (const item of step.observation?.results ?? [])
        if (item.content != null) content(item.content);
    }
    for (const child of t.subagent_trajectories ?? []) visit(child);
  };
  visit(result.trajectory);
  return { ...result, media: [...assets.values()], file, mediaRoot: output };
}

export async function readTrajectory(dir: string): Promise<AtifTrajectory | null> {
  try {
    return AtifTrajectory.parse(
      JSON.parse(await readSessionInput(join(dir, "trajectory.json"), dirname(dirname(dir)))),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function trajectorySummary(trajectory: AtifTrajectory): NonNullable<Run["trajectory"]> {
  const orbit = trajectory.extra?.orbit;
  if (!orbit) throw new Error("trajectory is missing Orbit provenance");
  return {
    ...(AtifSource.safeParse(orbit.metadata?.source).success
      ? { source: AtifSource.parse(orbit.metadata?.source) }
      : {}),
    schema: trajectory.schema_version,
    steps: trajectory.steps.length,
    completeness: orbit.completeness,
    importer: orbit.importer,
  };
}

/** Only called after execution has stopped. Refuse pre-existing Agent-controlled links. */
function privateDirectory(base: string, path: string) {
  const rel = relative(base, path);
  if (rel.startsWith("..") || resolve(base, rel) !== path)
    throw new Error("unsafe trajectory directory");
  let parent = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    parent = join(parent, part);
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const st = lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe trajectory directory");
  }
}

export async function saveTrajectory(
  root: string,
  result: TrajectoryConversion & { file: string; mediaRoot?: string },
  previous: AtifTrajectory | null,
  redact: (text: string) => string,
): Promise<AtifTrajectory> {
  const orbit = join(root, "orbit");
  const agent = join(orbit, "agent");
  const mediaRoot = result.mediaRoot ?? agent;
  const dir = join(orbit, "trajectory");
  privateDirectory(root, dir);
  privateDirectory(root, join(dir, "media"));
  for (const asset of result.media) {
    if (
      !/^media\/[a-f0-9]{64}\.(png|jpg|gif|webp|wav|mp3|m4a|aac|ogg|flac|weba|aiff)$/.test(
        asset.path,
      )
    )
      throw new Error("unsafe trajectory media path");
    const target = join(dir, asset.path);
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())
        throw new Error("unsafe trajectory media file");
      continue;
    }
    let data: Buffer;
    if (asset.base64 !== undefined) data = Buffer.from(asset.base64, "base64");
    else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(asset.sourcePath))
        throw new Error("remote media is not downloaded during trajectory generation");
      const source = asset.sourcePath.startsWith("/orbit/agent/")
        ? join(agent, asset.sourcePath.slice("/orbit/agent/".length))
        : result.mediaRoot && asset.sourcePath.startsWith("/orbit/output/")
          ? join(mediaRoot, asset.sourcePath.slice("/orbit/output/".length))
          : resolve(dirname(result.file), asset.sourcePath);
      const actual = await realpath(source);
      if (!actual.startsWith((await realpath(mediaRoot)) + sep))
        throw new Error("trajectory media leaves its source root");
      // The bounded descriptor reader also supports binary content via a lossless base64 encoding.
      data = Buffer.from(
        await readSessionInput(source, mediaRoot, 32 * 1024 * 1024, "base64"),
        "base64",
      );
    }
    writeFileSync(target, data, { mode: 0o600, flag: "wx" });
  }
  const trajectory = redactTrajectory(result.trajectory, redact);
  if (previous) {
    const importer = previous.extra?.orbit?.importer;
    if (importer) {
      const name = importer.name.replace(/[^a-z0-9-]/gi, "_");
      const backup = join(dir, `trajectory.${name}-v${importer.version}.json`);
      if (!existsSync(backup))
        writeFileSync(backup, `${JSON.stringify(redactTrajectory(previous, redact), null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
    }
  }
  const temp = mkdtempSync(join(dir, ".write-"));
  try {
    const file = join(temp, "trajectory.json");
    writeFileSync(file, `${JSON.stringify(trajectory, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(file, join(dir, "trajectory.json"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return trajectory;
}

export function redactTrajectory(
  value: AtifTrajectory,
  redact: (text: string) => string,
): AtifTrajectory {
  const clean = (v: unknown): unknown =>
    typeof v === "string"
      ? redact(v)
      : Array.isArray(v)
        ? v.map(clean)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, item]) => [k, clean(item)]))
          : v;
  return AtifTrajectory.parse(clean(value));
}
