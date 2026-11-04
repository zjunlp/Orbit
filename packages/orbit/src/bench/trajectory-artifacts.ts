import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Run, ScoreResult, SessionMessage } from "../contracts/index.ts";
import { efeActions, importEfeTrajectory } from "./trajectory.ts";

async function readArtifact(root: string, relative: string, limit: number): Promise<Buffer | null> {
  let path = root;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i] ?? "");
    const info = await lstat(path).catch(() => null);
    if (!info) return null;
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
      throw new Error("trajectory artifact is not a regular collected file");
    if (i === parts.length - 1 && info.size > limit)
      throw new Error("trajectory artifact exceeds import limit");
  }
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min((await file.stat()).size, limit + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error("trajectory artifact exceeds import limit");
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

/** Called by the daemon after scoring; review failures never change evaluation or reward. */
export async function addEfeTrajectory(
  output: string,
  run: Run,
  score: ScoreResult,
  messages: SessionMessage[],
  goal: string,
): Promise<void> {
  const service = run.spec.services.find((item) => item.name === "sim");
  if (!service?.collect.includes("/data/episode.jsonl")) return;
  const root = "services/sim/data";
  try {
    const directory = await lstat(output);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("trajectory output must be a real directory");
    const journal = await readArtifact(output, `${root}/episode.jsonl`, 16 * 1024 * 1024);
    const final = await readArtifact(output, `${root}/final.json`, 1024 * 1024);
    if (!journal || !final) throw new Error("EFE journal or final verdict is missing");
    const archive = await readArtifact(output, `${root}/trajectory.npz`, 64 * 1024 * 1024);
    const media = async (name: string) => {
      const path = `${root}/${name}`;
      // Validate every parent without loading video bytes.
      let current = output;
      for (const part of path.split("/")) {
        current = join(current, part);
        const entry = await lstat(current).catch(() => null);
        if (!entry || entry.isSymbolicLink()) return undefined;
      }
      return (await lstat(current)).isFile() ? path : undefined;
    };
    const trace = importEfeTrajectory({
      goal,
      journal: journal.toString("utf8"),
      final: JSON.parse(final.toString("utf8")),
      ...(archive ? { actions: efeActions(archive) } : {}),
      messages,
      video: await media("replay.mp4"),
      lastFrame: await media("replay.last.png"),
    });
    const text = JSON.stringify(trace);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("episode index exceeds preview limit");
    const temp = join(output, `.orbit-trajectory-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { mode: 0o600, flag: "wx" });
      await rename(temp, join(output, "orbit-trajectory.json"));
    } finally {
      await rm(temp, { force: true });
    }
    score.review ??= { files: [], items: [], details: {} };
    score.review.files = [
      ...score.review.files.filter(
        (file) => file.path !== "orbit-trajectory.json" || file.phase !== "solve",
      ),
      {
        label: "Episode and Agent session",
        phase: "solve",
        path: "orbit-trajectory.json",
        kind: "episode",
      },
    ];
    score.review.details = {
      ...score.review.details,
      trajectoryCompleteness: trace.completeness ?? "unspecified",
      trajectoryState:
        "MetaWorld+ records executed actions; proprioception is not retained by the sidecar",
    };
  } catch (error) {
    score.issues = [...(score.issues ?? []), `trajectory import: ${(error as Error).message}`];
  }
}
