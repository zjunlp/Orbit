import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  AtifTrajectory,
  type ExportTrialContext,
  type Run,
  TrajectoryExportManifest,
  type TrajectoryExportRequest,
  type TrajectoryExportResult,
} from "../contracts/index.ts";
import type { Redactor } from "../lib/redact.ts";
import { VERSION } from "../lib/version.ts";
import {
  chatTrajectories,
  prepareTrajectory,
  trajectoryCounts,
  trajectoryMedia,
} from "../sessions/export/convert.ts";
import { assertNoSecrets, redactExport } from "../sessions/export/security.ts";
import { trajectoryTokens } from "../sessions/tokens.ts";
import { UserError } from "./service.ts";

export const TRAJECTORY_LICENSE_NOTICE =
  "Trajectories may contain upstream benchmark content and model-generated content. Check applicable licenses before redistribution.";
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
interface ExportDeps {
  selected: { run: Run; contexts: ExportTrialContext[] }[];
  protectedRoots: string[];
  trajectory: (run: Run) => Promise<AtifTrajectory | null>;
  media: (run: Run, path: string) => Promise<ReadableStream<Uint8Array> | null>;
  redactor: (run?: Run) => Redactor;
  signal?: AbortSignal;
}

/** Daemon-owned export, using the same trajectory and media loaders for local and worker Runs. */
export async function exportTrajectories(
  request: TrajectoryExportRequest,
  deps: ExportDeps,
): Promise<TrajectoryExportResult> {
  if (!isAbsolute(request.out))
    throw new UserError("export output must be an absolute path on the daemon host");
  const out = join(await realpath(dirname(resolve(request.out))), basename(resolve(request.out)));
  for (const root of deps.protectedRoots) {
    const actual = await realpath(root).catch(() => resolve(root));
    if (out === actual || out.startsWith(actual + sep))
      throw new UserError("export outside Orbit's home and data directories");
  }
  if (
    await lstat(out).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    })
  )
    throw new UserError("export output already exists; choose a new directory");
  const stage = await mkdtemp(join(dirname(out), ".orbit-trajectory-export-"));
  let reserved = false;
  let published = false;
  let total = 0;
  const files: TrajectoryExportManifest["files"] = [];
  const entries: TrajectoryExportManifest["entries"] = [];
  const { out: _out, ...originalFilters } = request;
  let filters: unknown = originalFilters;
  const budget = (bytes: number) => {
    total += bytes;
    if (total > MAX_EXPORT_BYTES) throw new UserError("export exceeds 1 GiB; narrow the selection");
    deps.signal?.throwIfAborted();
  };
  const save = async (path: string, data: Buffer) => {
    budget(data.length);
    await mkdir(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(stage, path), data, { flag: "wx", mode: 0o600 });
    files.push({
      path,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  };
  const json = (value: unknown, path: string, redactor: Redactor) => {
    const clean = redactExport(value, redactor);
    assertNoSecrets(clean, path);
    return `${JSON.stringify(clean)}\n`;
  };
  let dataset: Awaited<ReturnType<typeof open>> | null = null;
  const datasetHash = createHash("sha256");
  let datasetBytes = 0;
  try {
    if (request.format === "chat-jsonl")
      dataset = await open(join(stage, "dataset.jsonl"), "wx", 0o600);
    for (const [index, { run, contexts }] of deps.selected.entries()) {
      deps.signal?.throwIfAborted();
      const redactor = deps.redactor(run);
      const source = await deps.trajectory(run);
      if (!source) throw new UserError(`Run ${run.id} has no Agent trajectory`);
      const trajectory = AtifTrajectory.parse(
        redactExport(prepareTrajectory(source, request.reasoning), redactor),
      );
      assertNoSecrets(trajectory, `entries[${index}].trajectory`);
      const directory = `runs/${index + 1}`;
      for (const path of trajectoryMedia(trajectory)) {
        const body = await deps.media(run, path);
        if (!body) throw new UserError(`Run ${run.id} media unavailable`);
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            deps.signal?.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > MAX_MEDIA_BYTES || total + bytes > MAX_EXPORT_BYTES)
              throw new UserError("trajectory media exceeds export limit");
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const data = Buffer.concat(chunks);
        const text = data.toString("utf8");
        if (redactor.apply(text) !== text)
          throw new UserError(`secret in media at entries[${index}].${path}`);
        assertNoSecrets(text, `entries[${index}].${path}`);
        if (createHash("sha256").update(data).digest("hex") !== basename(path).split(".")[0])
          throw new UserError(`media hash mismatch at entries[${index}].${path}`);
        await save(`${directory}/${path}`, data);
      }
      const path = request.format === "atif" ? `${directory}/trajectory.json` : "dataset.jsonl";
      if (dataset) {
        for (const row of chatTrajectories(trajectory, run.id, directory)) {
          const line = Buffer.from(json(row, `entries[${index}].messages`, redactor));
          budget(line.length);
          await dataset.writeFile(line);
          datasetHash.update(line);
          datasetBytes += line.length;
        }
      } else await save(path, Buffer.from(json(trajectory, path, redactor)));
      filters = redactExport(filters, redactor);
      const entry: TrajectoryExportManifest["entries"][number] = {
        run: run.id,
        path,
        execution: run.state,
        cleanup: run.cleanup,
        exitCode: run.exitCode,
        contexts,
        tokens: trajectoryTokens(source),
        completeness: source.extra?.orbit?.completeness ?? null,
        ...trajectoryCounts(trajectory),
      };
      entries.push(redactExport(entry, redactor) as typeof entry);
    }
    if (dataset) {
      await dataset.close();
      files.push({ path: "dataset.jsonl", bytes: datasetBytes, sha256: datasetHash.digest("hex") });
    }
    const manifest = TrajectoryExportManifest.parse(
      redactExport(
        {
          version: 1,
          exporter: { name: "orbit", version: VERSION },
          createdAt: new Date().toISOString(),
          format: request.format,
          reasoning: request.reasoning,
          filters,
          licenseNotice: TRAJECTORY_LICENSE_NOTICE,
          entries,
          files,
        },
        deps.redactor(),
      ),
    );
    await save("manifest.json", Buffer.from(json(manifest, "manifest.json", deps.redactor())));
    deps.signal?.throwIfAborted();
    await mkdir(out, { mode: 0o700 });
    reserved = true;
    await rename(stage, out);
    published = true;
    return { out, manifest: join(out, "manifest.json"), runs: entries.length, files: files.length };
  } finally {
    await dataset?.close().catch(() => {});
    if (!published) {
      await rm(stage, { recursive: true, force: true });
      if (reserved) await rmdir(out).catch(() => {});
    }
  }
}
