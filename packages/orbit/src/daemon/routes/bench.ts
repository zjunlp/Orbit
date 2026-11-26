import type { Hono } from "hono";
import { scaffoldBenchmark } from "../../bench/scaffold.ts";
import { BenchInitRequest } from "../../contracts/bench-init.ts";
import type { BenchReport } from "../../contracts/index.ts";
import { BenchLabels, type Benchmark, PolicyDefinition } from "../../contracts/index.ts";
import { NotFoundError, UserError } from "../../runs/service.ts";
import type { AppDeps } from "../app.ts";
import { num } from "../http.ts";

export function registerBenchRoutes(api: Hono, deps: AppDeps): void {
  const { bench, benchmarks } = deps;
  api.post("/bench/init", async (c) =>
    c.json(await scaffoldBenchmark(deps.paths, BenchInitRequest.parse(await c.req.json())), 201),
  );
  api.get("/policies", (c) => c.json({ policies: bench.policies.list() }));
  api.post("/policies", async (c) =>
    c.json(bench.policies.put(PolicyDefinition.parse(await c.req.json())), 201),
  );
  api.delete("/policies/:name", (c) => {
    if (!bench.policies.remove(c.req.param("name"))) throw new NotFoundError("policy not found");
    return c.json({ ok: true });
  });
  // Benchmarks: registered checkouts, jobs of trials, and method comparison.
  api.get("/benchmarks", (c) =>
    c.json<{ benchmarks: Benchmark[] }>({ benchmarks: benchmarks.list() }),
  );
  api.post("/benchmarks/check", async (c) =>
    c.json(await bench.checkRegistration(await c.req.json())),
  );
  api.post("/benchmarks", async (c) => {
    const createOnly = c.req.query("createOnly");
    if (createOnly !== undefined && createOnly !== "true" && createOnly !== "false")
      throw new UserError("createOnly must be true or false");
    return c.json(
      await bench.register(await c.req.json(), { createOnly: createOnly === "true" }),
      201,
    );
  });
  api.get("/bench/resources", (c) => c.json(bench.preparation.catalog()));
  api.post("/bench/resources/:family/prepare", async (c) =>
    c.json(await bench.preparation.submit(c.req.param("family"), await c.req.json()), 201),
  );
  api.get("/bench/preparations/:id", async (c) =>
    c.json(await bench.preparation.status(c.req.param("id"))),
  );
  api.delete("/benchmarks/:name", (c) => {
    if (!benchmarks.remove(c.req.param("name"))) throw new NotFoundError("benchmark not found");
    return c.json({ ok: true });
  });
  api.get("/benchmarks/:name/tasks", async (c) =>
    c.json(await bench.infoOf(bench.benchmark(c.req.param("name")))),
  );
  api.post("/benchmarks/:name/split", async (c) =>
    c.json(await bench.split(c.req.param("name"), await c.req.json())),
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
  api.get("/bench/transfer", (c) => c.json(bench.transfer(c.req.query())));
  api.post("/bench/gates/plan", async (c) => c.json(bench.gatePlan(await c.req.json())));
  api.post("/bench/gates/check-bundle", async (c) =>
    c.json(bench.gateBundleCheck(await c.req.json())),
  );
  api.post("/bench/gates", async (c) => c.json(bench.gate(await c.req.json()), 201));
  api.get("/bench/gates", (c) =>
    c.json(bench.gates(c.req.query("child"), num(c.req.query("limit"), 100))),
  );
  api.get("/bench/gates/:id", (c) => c.json(bench.gateRecord(c.req.param("id"))));
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
