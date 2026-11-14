import { join } from "node:path";
import type { Hono } from "hono";
import { selectTrajectories } from "../../bench/trajectory-export.ts";
import { TrajectoryExportRequest } from "../../contracts/index.ts";
import { outputFile } from "../../records/index.ts";
import { UserError } from "../../runs/service.ts";
import { exportTrajectories } from "../../runs/trajectory-export.ts";
import { TrajectoryExportError } from "../../sessions/export/security.ts";
import type { AppDeps } from "../app.ts";
import { remoteRecords } from "../http.ts";

export function registerTrajectoryExportRoutes(api: Hono, deps: AppDeps): void {
  api.post("/trajectory/export", async (c) => {
    const request = TrajectoryExportRequest.parse(await c.req.json());
    const { runs, cluster, paths } = deps;
    try {
      const selected = selectTrajectories(deps.store, request);
      const result = await exportTrajectories(request, {
        selected,
        protectedRoots: [paths.home, paths.data],
        signal: c.req.raw.signal,
        redactor: (run) => runs.redactor(run),
        trajectory: async (run) => {
          const value = run.remote
            ? await remoteRecords(() => cluster.trajectory(run))
            : await runs.trajectory(run.id);
          if (run.remote) runs.recordTrajectory(run.id, value);
          return value;
        },
        media: async (run, path) => {
          if (run.remote) {
            const response = await remoteRecords(() => cluster.trajectoryFile(run, path));
            if (!response.ok) {
              await response.body?.cancel();
              throw new UserError("worker trajectory media unavailable");
            }
            return response.body;
          }
          return (
            (
              await outputFile(
                runs.dirs(run.id).root,
                join("orbit", "trajectory", path),
                c.req.raw.signal,
              )
            )?.body ?? null
          );
        },
      });
      return c.json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        (error instanceof TrajectoryExportError ||
          ["ENOENT", "EEXIST", "ENOTDIR", "EACCES", "EPERM", "ENOSPC"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          ))
      )
        throw new UserError(error.message);
      throw error;
    }
  });
}
