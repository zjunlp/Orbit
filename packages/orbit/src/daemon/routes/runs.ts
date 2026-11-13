import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  AtifSource,
  EnvironmentKind,
  isTerminal,
  type Run,
  RunCursor,
  type RunList,
  type RunSessions,
  RunState,
} from "../../contracts/index.ts";
import {
  decodePath,
  listArtifacts,
  outputFile,
  readDiff,
  readLog,
  readMetrics,
} from "../../records/index.ts";
import { alignEnvironment } from "../../sessions/environment.ts";
import { loadTranscript, projectTranscript } from "../../sessions/index.ts";
import type { AppDeps } from "../app.ts";
import { must, num, remoteRecords } from "../http.ts";

export function registerRunsRoutes(api: Hono, deps: AppDeps): void {
  const { runs, cluster } = deps;
  const waiters = new Map<string, Set<(run: Run) => void>>();
  const subscribers = new Set<(event: string, data: string) => void>();
  runs.on("change", ({ run }) => {
    if (isTerminal(run.state) && run.cleanup !== "pending")
      for (const finish of waiters.get(run.id) ?? []) finish(run);
    if (subscribers.size) {
      const data = JSON.stringify(run);
      for (const send of subscribers) send("run", data);
    }
  });
  runs.on("deleted", (ids) => {
    if (subscribers.size) {
      const data = JSON.stringify({ ids });
      for (const send of subscribers) send("deleted", data);
    }
  });

  api.get("/runs", (c) => {
    const states = c.req
      .query("state")
      ?.split(",")
      .filter(Boolean)
      .map((s) => RunState.parse(s));
    const limit = num(c.req.query("limit"), 500);
    const folder = c.req.query("folder") || undefined;
    const cursor = c.req.query("before");
    const before = cursor ? RunCursor.parse(JSON.parse(cursor)) : undefined;
    const page = runs.storeList({ states, group: c.req.query("group"), folder, limit, before });
    const last = page.at(-1);
    return c.json<RunList>({
      runs: page,
      next:
        last && page.length === Math.max(1, limit)
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    });
  });
  api.post("/runs", async (c) =>
    c.json(await runs.submit(await c.req.json(), { folder: c.req.query("folder") }), 201),
  );

  api.post("/runs/check", async (c) => c.json(await runs.check(await c.req.json())));

  api.get("/runs/:id", (c) => c.json(must(runs.get(c.req.param("id")))));
  api.post("/runs/:id/cancel", async (c) => c.json(await runs.cancel(c.req.param("id"))));
  api.post("/runs/:id/resume", async (c) =>
    c.json(await runs.resume(c.req.param("id"), await c.req.json()), 201),
  );
  api.put("/runs/:id/note", async (c) => {
    const { note } = z.object({ note: z.string().max(100_000) }).parse(await c.req.json());
    return c.json(runs.setNote(c.req.param("id"), note));
  });

  /** Long-poll until the run is terminal or `timeout` seconds pass; returns the current run. */
  api.get("/runs/:id/wait", async (c) => {
    const id = c.req.param("id");
    const timeoutMs = Math.min(num(c.req.query("timeout"), 30), 120) * 1000;
    const run = must(runs.get(id));
    if (isTerminal(run.state) && run.cleanup !== "pending") return c.json(run);
    const done = await new Promise<Run>((resolve) => {
      const signal = c.req.raw.signal;
      const own = waiters.get(id) ?? new Set<(run: Run) => void>();
      const t = setTimeout(() => finish(runs.get(id) ?? run), timeoutMs);
      const onAbort = () => finish(run);
      const finish = (r: Run) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        own.delete(finish);
        if (own.size === 0) waiters.delete(id);
        resolve(r);
      };
      own.add(finish);
      waiters.set(id, own);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return c.json(done);
  });

  api.get("/runs/:id/events", (c) => {
    const id = c.req.param("id");
    must(runs.get(id));
    return c.json({ events: runs.events(id, num(c.req.query("after"), 0)) });
  });

  api.get("/runs/:id/logs", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    const offset = num(c.req.query("offset"), 0);
    const limit = num(c.req.query("limit"), 256 * 1024);
    // Process runs write straight to the log; it is redacted in place only when they end.
    const terminal = isTerminal(run.state);
    const chunk = await readLog(
      runs.dirs(run.id).log,
      offset,
      limit,
      terminal,
      run.spec.backend === "process" && !terminal ? runs.redactor(run) : undefined,
    );
    return c.json(chunk);
  });

  /** The whole combined log as plain text (for download). */
  api.get("/runs/:id/log.txt", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    const file = runs.dirs(run.id).log;
    const st = await stat(file).catch(() => null);
    if (!st) return c.text("");
    c.header("content-type", "text/plain; charset=utf-8");
    if (c.req.query("download")) c.header("content-disposition", attachment(`${run.id}.log`));
    // As for /logs: a running process run's log is not redacted on disk yet.
    if (run.spec.backend === "process" && !isTerminal(run.state))
      return c.body(
        Readable.toWeb(
          createReadStream(file).pipe(runs.redactor(run).stream({ final: false })),
        ) as ReadableStream,
      );
    c.header("content-length", String(st.size));
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });

  // Irreversible: the CLI and the Web UI ask for a typed confirmation before calling it.
  api.post("/runs/delete", async (c) => {
    const { ids } = z
      .object({ ids: z.array(z.string()).min(1).max(5000) })
      .parse(await c.req.json());
    return c.json(await runs.delete(ids));
  });

  api.get("/runs/:id/metrics", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    return c.json(await readMetrics(runs.dirs(run.id).metrics));
  });

  // Outputs of a run on another node stay there and are read through it on demand.
  api.get("/runs/:id/artifacts", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    if (run.remote) return c.json(must(await remoteRecords(() => cluster.artifacts(run))));
    return c.json(await listArtifacts(runs.dirs(run.id).output));
  });

  api.get("/runs/:id/files/*", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    const rel = decodePath(c.req.path, "/files/");
    // Run outputs are untrusted content on the daemon's origin: no script, no type sniffing.
    c.header("content-security-policy", ARTIFACT_CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("content-type", contentType(rel));
    if (c.req.query("download")) c.header("content-disposition", attachment(rel));
    if (run.remote) {
      const res = await remoteRecords(() => cluster.file(run, rel));
      if (!res || res.status === 404) return c.json({ error: "not found" }, 404);
      c.header("content-length", res.headers.get("content-length") ?? undefined);
      if (c.req.method === "HEAD") {
        await res.body?.cancel();
        return c.body(null);
      }
      return c.body(res.body as ReadableStream);
    }
    const f = await outputFile(runs.dirs(run.id).output, rel, c.req.raw.signal);
    if (!f) return c.json({ error: "not found" }, 404);
    c.header("content-length", String(f.size));
    if (c.req.method === "HEAD") {
      await f.body.cancel();
      return c.body(null);
    }
    return c.body(f.body);
  });

  api.get("/runs/:id/diff", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    return c.json(await readDiff(runs.dirs(run.id).diff));
  });

  const trajectory = async (run: Run, rebuild = false, source?: AtifSource) => {
    const result = run.remote
      ? await remoteRecords(() => cluster.trajectory(run, rebuild, source))
      : await runs.trajectory(run.id, rebuild, false, source);
    if (run.remote) runs.recordTrajectory(run.id, result);
    return result;
  };
  api.get("/runs/:id/environment", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    const kind = EnvironmentKind.parse(c.req.query("kind"));
    const path = z.string().min(1).parse(c.req.query("path"));
    const sessionRun = must(runs.get(c.req.query("session") ?? run.id));
    const limit = (kind === "conversation" ? 16 : 2) * 1024 * 1024;
    let body: ReadableStream<Uint8Array> | null;
    let size: number;
    if (run.remote) {
      const response = await remoteRecords(() => cluster.file(run, path));
      if (!response.ok) {
        await response.body?.cancel();
        return c.json(
          { error: "environment file unavailable" },
          response.status === 404 ? 404 : 502,
        );
      }
      size = Number(response.headers.get("content-length") ?? 0);
      body = response.body;
    } else {
      const file = await outputFile(runs.dirs(run.id).output, path, c.req.raw.signal);
      if (!file) return c.json({ error: "not found" }, 404);
      size = file.size;
      body = file.body;
    }
    if (!body) return c.json({ error: "empty environment file" }, 422);
    if (size > limit) {
      await body.cancel();
      return c.json({ error: "environment preview exceeds limit" }, 413);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > limit) return c.json({ error: "environment preview exceeds limit" }, 413);
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    let evidence: unknown;
    try {
      evidence = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return c.json({ error: "invalid environment JSON" }, 400);
    }
    let failed = false;
    const atif = await trajectory(sessionRun).catch(() => {
      failed = true;
      return null;
    });
    const result = alignEnvironment(kind, evidence, atif, sessionRun.id);
    if (failed) result.completeness = "truncated";
    c.header("cache-control", "no-store");
    return c.json(result);
  });
  api.get("/runs/:id/trajectory", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await trajectory(must(runs.get(c.req.param("id")))));
  });
  api.post("/runs/:id/trajectory/rebuild", async (c) => {
    c.header("cache-control", "no-store");
    const text = await c.req.text();
    const { source } = z
      .object({ source: AtifSource.optional() })
      .parse(text ? JSON.parse(text) : {});
    return c.json(await trajectory(must(runs.get(c.req.param("id"))), true, source));
  });
  api.get("/runs/:id/trajectory/files/*", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    const rel = decodePath(c.req.path, "/files/");
    if (!/^media\/[a-f0-9]{64}\.(png|jpg|gif|webp|wav|mp3|m4a|aac|ogg|flac|weba|aiff)$/.test(rel))
      return c.json({ error: "not found" }, 404);
    c.header("content-security-policy", ARTIFACT_CSP);
    c.header("x-content-type-options", "nosniff");
    c.header("content-type", contentType(rel));
    c.header("cache-control", "no-store");
    if (run.remote) {
      const res = await remoteRecords(() => cluster.trajectoryFile(run, rel));
      if (res.status === 404) return c.json({ error: "not found" }, 404);
      c.header("content-length", res.headers.get("content-length") ?? undefined);
      if (c.req.method === "HEAD") {
        await res.body?.cancel();
        return c.body(null);
      }
      return c.body(res.body as ReadableStream);
    }
    const file = await outputFile(
      runs.dirs(run.id).root,
      join("orbit", "trajectory", rel),
      c.req.raw.signal,
    );
    if (!file) return c.json({ error: "not found" }, 404);
    c.header("content-length", String(file.size));
    if (c.req.method === "HEAD") {
      await file.body.cancel();
      return c.body(null);
    }
    return c.body(file.body);
  });

  api.get("/runs/:id/session", async (c) => {
    const run = must(runs.get(c.req.param("id")));
    let submitterError: string | null = null;
    const submitter = run.spec.agent
      ? await loadTranscript(run.spec.agent).catch((error) => {
          submitterError = runs.redactor(run).apply((error as Error).message);
          return null;
        })
      : null;
    let agentError: string | null = null;
    const atif = await trajectory(run).catch((error) => {
      agentError = runs.redactor(run).apply((error as Error).message);
      return null;
    });
    const agent = atif ? projectTranscript(atif) : null;
    // The same redactor is used for stored trajectories and host submitter previews.
    const redact = (t: typeof submitter) =>
      t
        ? {
            ...t,
            messages: t.messages.map((m) => ({ ...m, text: runs.redactor(run).apply(m.text) })),
          }
        : null;
    c.header("cache-control", "no-store");
    return c.json<RunSessions>({
      submitter: redact(submitter),
      submitterError:
        submitterError ??
        (run.spec.agent && !submitter ? "session transcript not found on this node" : null),
      agent,
      agentError,
    });
  });

  /** Server-sent events: `run` with the full Run on every change. */
  api.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string, data: string) => {
        void stream.writeSSE({ event, data }).catch(() => stream.abort());
      };
      const signal = c.req.raw.signal;
      const onAbort = () => stream.abort();
      subscribers.add(send);
      const ping = setInterval(() => send("ping", ""), 15_000);
      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(resolve);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted || stream.aborted) {
            onAbort();
            resolve();
          }
        });
      } finally {
        clearInterval(ping);
        subscribers.delete(send);
        signal.removeEventListener("abort", onAbort);
      }
    }),
  );
}
const ARTIFACT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

/** `Content-Disposition` for a download, with a UTF-8 name and an ASCII fallback. */
function attachment(path: string): string {
  const name = path.split("/").pop() || "download";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aiff: "audio/aiff",
  weba: "audio/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  jsonl: "text/plain; charset=utf-8",
  html: "text/plain; charset=utf-8",
};

function contentType(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "text/plain; charset=utf-8";
}
