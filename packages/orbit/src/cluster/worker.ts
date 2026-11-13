// The cluster API a node serves to its primary on the exposed address. It only reaches runs that
// arrived from a primary, and code bundles; local runs and secrets are not exposed.

import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  AtifSource,
  CLUSTER_PREFIX,
  CLUSTER_PROTOCOL,
  type NodeInfo,
  type NodeProfile,
  RemoteSubmit,
  type Run,
} from "../contracts/index.ts";
import { tokenMatches } from "../lib/tokens.ts";
import { VERSION } from "../lib/version.ts";
import { decodePath, listArtifacts, outputFile } from "../records/index.ts";
import { NotFoundError, type RunService, UserError } from "../runs/service.ts";
import { bundleDir, isBundleHash, receiveBundle } from "../workspace/bundle.ts";
import type { DatasetRegistry } from "../workspace/datasets.ts";

export const MAX_RAW_CHUNK = 4 * 1024 * 1024;

export interface WorkerDeps {
  runs: RunService;
  datasets: DatasetRegistry;
  profiles: () => Promise<NodeProfile[]>;
  bundles: string;
  /** Current cluster token (read per request, so rotation applies at once). */
  token: () => string;
}

export { tokenMatches };

export async function nodeInfo(deps: Omit<WorkerDeps, "bundles" | "token">): Promise<NodeInfo> {
  const ledger = deps.runs.ledger();
  return {
    name: deps.runs.nodeName,
    version: VERSION,
    protocol: CLUSTER_PROTOCOL,
    resources: await deps.runs.resources(),
    leases: ledger.leases,
    queued: ledger.queued.length,
    datasets: deps.datasets.list().map((d) => d.name),
    profiles: await deps.profiles(),
  };
}

export function createWorkerApp(deps: WorkerDeps): Hono {
  const { runs } = deps;
  const app = new Hono();
  const api = new Hono();

  api.use("*", async (c, next) => {
    if (!tokenMatches(c.req.header("authorization"), deps.token()))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  /** A run that came from a primary. */
  const own = (c: Context): Run => {
    const run = runs.get(c.req.param("id") as string);
    if (!run?.origin) throw new NotFoundError("run not found");
    return run;
  };

  api.get("/info", async (c) => c.json(await nodeInfo(deps)));

  api.on("HEAD", "/bundles/:hash", (c) => {
    const hash = c.req.param("hash");
    return c.body(
      null,
      isBundleHash(hash) && existsSync(bundleDir(deps.bundles, hash)) ? 200 : 404,
    );
  });
  api.put("/bundles/:hash", async (c) => {
    const body = c.req.raw.body;
    if (!body) throw new UserError("empty bundle");
    try {
      await receiveBundle(deps.bundles, c.req.param("hash"), body);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    return c.json({ ok: true });
  });

  api.post("/runs", async (c) =>
    c.json(await runs.submitRemote(RemoteSubmit.parse(await c.req.json()))),
  );
  api.get("/runs/:id", (c) => c.json(own(c)));
  api.post("/runs/:id/cancel", async (c) => c.json(await runs.cancel(own(c).id)));
  api.get("/runs/:id/events", (c) =>
    c.json({ events: runs.events(own(c).id, Number(c.req.query("after") ?? 0)) }),
  );

  api.get("/runs/:id/raw/:kind", async (c) => {
    const run = own(c);
    const kind = z.enum(["log", "metrics"]).parse(c.req.param("kind"));
    const file = kind === "log" ? runs.dirs(run.id).log : runs.dirs(run.id).metrics;
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limit = Math.min(
      MAX_RAW_CHUNK,
      Math.max(1, Number(c.req.query("limit") ?? MAX_RAW_CHUNK) || MAX_RAW_CHUNK),
    );
    const fh = await open(file, "r").catch(() => null);
    if (!fh) {
      c.header("x-orbit-size", "0");
      return c.body(new Uint8Array(0));
    }
    try {
      const size = (await fh.stat()).size;
      const len = Math.max(0, Math.min(limit, size - offset));
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, offset);
      c.header("x-orbit-size", String(size));
      c.header("content-type", "application/octet-stream");
      return c.body(new Uint8Array(buf));
    } finally {
      await fh.close();
    }
  });

  api.get("/runs/:id/trajectory", async (c) => c.json(await runs.trajectory(own(c).id)));
  api.post("/runs/:id/trajectory/rebuild", async (c) => {
    const text = await c.req.text();
    const { source } = z
      .object({ source: AtifSource.optional() })
      .parse(text ? JSON.parse(text) : {});
    return c.json(await runs.trajectory(own(c).id, true, false, source));
  });
  api.get("/runs/:id/trajectory/files/*", async (c) => {
    const run = own(c);
    const rel = decodePath(c.req.path, "/files/");
    if (!/^media\/[a-f0-9]{64}\.(png|jpg|gif|webp|wav|mp3|m4a|aac|ogg|flac|weba|aiff)$/.test(rel))
      return c.json({ error: "not found" }, 404);
    const f = await outputFile(
      runs.dirs(run.id).root,
      join("orbit", "trajectory", rel),
      c.req.raw.signal,
    );
    if (!f) return c.json({ error: "not found" }, 404);
    c.header("content-length", String(f.size));
    if (c.req.method === "HEAD") {
      await f.body.cancel();
      return c.body(null);
    }
    return c.body(f.body);
  });

  api.get("/runs/:id/artifacts", async (c) =>
    c.json(await listArtifacts(runs.dirs(own(c).id).output)),
  );
  api.get("/runs/:id/files/*", async (c) => {
    const run = own(c);
    const f = await outputFile(
      runs.dirs(run.id).output,
      decodePath(c.req.path, "/files/"),
      c.req.raw.signal,
    );
    if (!f) return c.json({ error: "not found" }, 404);
    c.header("content-length", String(f.size));
    if (c.req.method === "HEAD") {
      await f.body.cancel();
      return c.body(null);
    }
    return c.body(f.body);
  });

  app.route(CLUSTER_PREFIX, api);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof UserError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: `invalid JSON: ${err.message}` }, 400);
    if (err instanceof URIError) return c.json({ error: err.message }, 400);
    console.error("orbit cluster:", err);
    return c.json({ error: err.message }, 500);
  });
  return app;
}
