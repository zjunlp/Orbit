import { accessSync, constants, existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import { loadResources, resolveResources } from "../../bench/resources.ts";
import type { BenchReport } from "../../contracts/index.ts";
import { BenchLabels, type Benchmark, BenchmarkInput } from "../../contracts/index.ts";
import { NotFoundError, UserError } from "../../runs/service.ts";
import type { AppDeps } from "../app.ts";
import { num } from "../http.ts";

export function registerBenchRoutes(api: Hono, deps: AppDeps): void {
  const { bench, benchmarks } = deps;
  // Benchmarks: registered checkouts, jobs of trials, and method comparison.
  api.get("/benchmarks", (c) =>
    c.json<{ benchmarks: Benchmark[] }>({ benchmarks: benchmarks.list() }),
  );
  api.post("/benchmarks", async (c) => {
    const input = BenchmarkInput.parse(await c.req.json());
    if (!existsSync(input.path)) throw new UserError(`benchmark path not found: ${input.path}`);
    if (input.adapter.startsWith("/")) {
      try {
        if (!statSync(input.adapter).isFile()) throw new Error();
        accessSync(input.adapter, constants.X_OK);
      } catch {
        throw new UserError(`adapter is not an executable file: ${input.adapter}`);
      }
    }
    // Listing the tasks once checks that the adapter answers (and the resources file fits) first.
    const { tasks } = await bench.infoOf({
      ...input,
      createdAt: "",
      updatedAt: "",
    });
    if (input.resources) {
      try {
        const ids = tasks.map((t) => t.id);
        resolveResources(loadResources(input.resources), ids, ids);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
    // Re-registering keeps the labels unless new ones are given.
    const labels = input.labels ?? benchmarks.get(input.name)?.labels;
    return c.json(benchmarks.put({ ...input, ...(labels ? { labels } : {}) }), 201);
  });
  api.delete("/benchmarks/:name", (c) => {
    if (!benchmarks.remove(c.req.param("name"))) throw new NotFoundError("benchmark not found");
    return c.json({ ok: true });
  });
  api.get("/benchmarks/:name/tasks", async (c) =>
    c.json(await bench.infoOf(bench.benchmark(c.req.param("name")))),
  );
  api.patch("/benchmarks/:name/labels", async (c) =>
    c.json(bench.label(c.req.param("name"), BenchLabels.parse(await c.req.json()))),
  );
  api.get("/bench/compatibility", (c) => c.json(bench.compatibility()));
  api.get("/methods", (c) => c.json(bench.methods(c.req.query("metric"))));
  api.get("/bench/catalog", (c) =>
    c.json(bench.catalog((c.req.query("refresh") ?? "").split(",").filter(Boolean))),
  );
  api.post("/bench/calibrations", async (c) =>
    c.json(await bench.calibrate(await c.req.json()), 201),
  );
  api.get("/bench/jobs", (c) => c.json(bench.jobs(num(c.req.query("limit"), 200))));
  api.post("/bench/jobs", async (c) =>
    c.json(await bench.submit(await c.req.json(), { folder: c.req.query("folder") }), 201),
  );
  api.get("/bench/jobs/:id", (c) => c.json(bench.job(c.req.param("id"))));
  api.get("/bench/jobs/:id/reports", (c) =>
    c.json<{ reports: BenchReport[] }>({ reports: bench.reports(c.req.param("id")) }),
  );
  api.post("/bench/jobs/:id/cancel", async (c) => c.json(await bench.cancel(c.req.param("id"))));
  api.post("/bench/jobs/:id/consolidate", async (c) =>
    c.json(await bench.consolidate(c.req.param("id"), await c.req.json())),
  );
  api.post("/bench/jobs/:id/rescore", async (c) =>
    c.json(bench.rescore(c.req.param("id"), await c.req.json().catch(() => ({})))),
  );
  api.delete("/bench/jobs/:id", async (c) => c.json(await bench.deleteJob(c.req.param("id"))));
  api.get("/bench/usage", (c) =>
    c.json(bench.usage((c.req.query("jobs") ?? "").split(",").filter(Boolean))),
  );
  api.get("/bench/compare", (c) =>
    c.json(bench.compare((c.req.query("jobs") ?? "").split(",").filter(Boolean))),
  );
}
