import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  BenchSplitManifest,
  parseTaskFile,
  TASK_FILE_MAX_BYTES,
  type TaskFileInput,
  type TaskPartition,
} from "../contracts/index.ts";

function readBounded(file: string, limit: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("task files and manifests must be regular files");
    if (stat.size > limit) throw new Error(`text file exceeds ${limit} bytes`);
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size)
      throw new Error("text file changed during read; retry with a stable file");
    return data.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

export function readTaskFile(file: string): { tasks: string[]; tasksFile: TaskFileInput } {
  const bytes = readBounded(file, TASK_FILE_MAX_BYTES);
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const tasks = parseTaskFile(content);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      readBounded(join(dirname(file), "split.json"), 1024 * 1024),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { tasks, tasksFile: { content, sha256 } };
    throw error;
  }
  const manifest = BenchSplitManifest.parse(JSON.parse(raw));
  const partition = (Object.keys(manifest.files) as TaskPartition[]).find(
    (p) => manifest.files[p].path === basename(file),
  );
  if (!partition) throw new Error("task file is not declared in the adjacent split.json");
  if (manifest.files[partition].sha256 !== sha256)
    throw new Error("task file SHA-256 differs from split.json");
  return { tasks, tasksFile: { content, sha256, frozen: { partition, manifest } } };
}
