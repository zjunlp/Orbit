// Synthetic scores with real Store, gate, HTTP handlers and CLI; execution remains paused.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { gate } from "../src/bench/gate.ts";
import { evaluateGate } from "../src/bench/gates.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { revisionOf } from "../src/bench/revision.ts";
import { BenchService } from "../src/bench/service.ts";
import { registerBench } from "../src/cli/bench.ts";
import { readGateInput } from "../src/cli/gate.ts";
import { OrbitClient } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import type { GateRecord, GateSubmissionInput } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";
import { base, child, fixture, method, parent } from "./fixtures/gate.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "orbit-gates-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = orbitPaths({ ORBIT_HOME: join(root, "home") });
  ensureHome(paths);
  const store = new Store(paths.db);
  cleanups.push(() => store.close());
  const f = fixture();
  const save = () => {
    for (const job of f.evidence.jobs) store.putJob(job);
    for (const report of f.evidence.reports) store.addReport(report);
  };
  const registry = new BenchmarkRegistry(paths.benchmarks);
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const bench = new BenchService({ store, paths, runs, registry });
  bench.stop();
  const app = createApp({
    token: "fixture",
    paths,
    runs,
    bench,
    store,
    benchmarks: registry,
    webDir: null,
  } as AppDeps);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, init));
  const client = new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 });
  const input = (): GateSubmissionInput => ({
    parent: parent.revision,
    child: child.revision,
    policy: f.policy,
    taskSets: f.evidence.taskSets,
  });
  return { ...f, root, paths, store, app, client, save, input };
}

describe("gate records and evidence resolution", () => {
  it("evaluates, lists and reads immutable self-contained records without running tasks", async () => {
    const f = setup();
    f.save();
    const record = await f.client.benchGate(f.input());
    expect(record.verdict.decision).toBe("accept");
    expect(await f.client.benchGateRecord(record.id)).toEqual(record);
    expect((await f.client.benchGates(child.revision))[0]?.id).toBe(record.id);
    expect((await f.client.benchGates(child.revision))[0]).not.toHaveProperty("evidence");
    expect(await f.client.benchGates(parent.revision)).toEqual([]);
    expect(f.store.listRuns()).toEqual([]);
    expect(() => f.store.addGate(record)).toThrow();
    f.store.deleteJob(f.target.a.id);
    f.store.deleteJob(f.target.b.id);
    expect(await f.client.benchGateRecord(record.id)).toEqual(record);
    expect(gate(parent.revision, child.revision, record.policy, record.evidence)).toEqual(
      record.verdict,
    );
    const next = await f.client.benchGate(f.input());
    expect(next.id).not.toBe(record.id);
    expect(next.verdict).toEqual(record.verdict);
  });
  it("resolves optional final-Agent evidence without confusing it with the promotion lineage", async () => {
    const f = setup();
    const final = f.pair(
      "final:0:other-agent",
      "held-out",
      Array(60).fill(40),
      Array(60).fill(70),
      "other-agent",
    );
    f.policy.final.push({ ...final.dataset, agents: ["other-agent"] });
    f.save();
    const record = await f.client.benchGate(f.input());
    expect(record.verdict).toMatchObject({ decision: "accept", level: "transferable" });
    const reopened = new Store(f.paths.db);
    try {
      expect(reopened.getGate(record.id)).toEqual(record);
    } finally {
      reopened.close();
    }
  });

  it("requires explicit selection for rescoring and preserves earlier verdicts", async () => {
    const f = setup();
    f.save();
    const first = await f.client.benchGate(f.input());
    const newer = structuredClone(f.target.rb);
    newer.revision = 2;
    for (const e of method(newer).entries) e.value = 0;
    f.store.addReport(newer);
    await expect(f.client.benchGate(f.input())).rejects.toThrow("explicit report selections");
    const selections = structuredClone(f.evidence.selections);
    assert(selections[0]);
    selections[0].child.revision = 2;
    const second = await f.client.benchGate({ ...f.input(), selections });
    expect(second.verdict.decision).toBe("reject");
    expect(await f.client.benchGateRecord(first.id)).toEqual(first);
    expect(second.verdict.alpha.round).toBe(1);
  });
  it("retains earlier sibling budget after source jobs are deleted", () => {
    const f = setup();
    f.save();
    const original = evaluateGate(f.store, f.input());
    f.store.deleteJob(f.target.b.id);
    const candidate = revisionOf({ ...base, bundleDigest: "c".repeat(64) });
    const job = structuredClone(f.target.b);
    job.id = "next";
    job.createdAt = "2026-11-15T00:00:00Z";
    job.revisions.candidate = candidate;
    const report = structuredClone(f.target.rb);
    report.jobId = job.id;
    f.store.putJob(job);
    f.store.addReport(report);
    const next = evaluateGate(f.store, { ...f.input(), child: candidate.revision });
    expect(original.verdict.alpha.round).toBe(1);
    expect(next.verdict.alpha.round).toBe(2);
    expect(next.verdict.inputs.priorChildren).toContain(child.revision);
  });
  it("does not truncate older lineage at the normal job listing limit", () => {
    const f = setup();
    f.save();
    for (let i = 0; i < 205; i++) {
      const job = structuredClone(f.target.a);
      job.id = `unrelated-${i}`;
      job.createdAt = "2099-01-01T00:00:00Z";
      job.revisions.candidate = revisionOf({ ...base, model: `unrelated-${i}` });
      f.store.putJob(job);
    }
    const record = evaluateGate(f.store, f.input());
    expect(record.verdict.decision).toBe("accept");
    expect(record.evidence.jobs).toHaveLength(2);
  });
  it("gives insufficient for missing reports without synthesizing current scores or costs", () => {
    const f = setup();
    for (const job of f.evidence.jobs) f.store.putJob(job);
    const record = evaluateGate(f.store, f.input());
    expect(record.verdict.decision).toBe("insufficient");
    expect(f.store.reports(f.target.a.id)).toEqual([]);
  });
  it("rejects invalid hashes, duplicate snapshots, unknown references and API writes without auth", async () => {
    const f = setup();
    f.save();
    const changed = { ...f.input(), taskSets: [{ file: "gate.txt", content: "wrong\n" }] };
    await expect(f.client.benchGate(changed)).rejects.toThrow("changed task file");
    await expect(
      f.client.benchGate({
        ...f.input(),
        taskSets: [...f.evidence.taskSets, ...f.evidence.taskSets],
      }),
    ).rejects.toThrow("duplicate task files");
    const selections = structuredClone(f.evidence.selections);
    assert(selections[0]);
    selections[0].parent.revision = 99;
    await expect(f.client.benchGate({ ...f.input(), selections })).rejects.toThrow(
      "selected report is unavailable",
    );
    expect(
      (
        await f.app.request("/api/v1/bench/gates", {
          method: "POST",
          body: JSON.stringify(f.input()),
        })
      ).status,
    ).toBe(401);
    expect(await f.client.benchGates()).toEqual([]);
    await expect(f.client.benchGateRecord("missing")).rejects.toThrow("not found");
  });
});

describe("A/A and provenance calibration", () => {
  it("compares identical bundles through statistics and rejects reused runs", async () => {
    const f = setup();
    f.target.b.revisions.candidate = parent;
    f.target.b.spec.lineage = {};
    for (const e of method(f.target.rb).entries) e.value = 50;
    f.save();
    const input = {
      ...f.input(),
      child: parent.revision,
      mode: "calibration-aa" as const,
      selections: f.evidence.selections,
    };
    const r = await f.client.benchGate(input);
    expect(r.verdict.decision).toBe("insufficient");
    expect(r.verdict.level).toBeNull();
    expect(r.verdict.checks.filter((c) => c.prerequisite).every((c) => c.status === "pass")).toBe(
      true,
    );
    expect(r.verdict.checks.find((c) => c.kind === "improvement")?.diff?.mean).toBe(0);
    const same = structuredClone(input);
    assert(same.selections[0]);
    same.selections[0].child = same.selections[0].parent;
    const invalid = await f.client.benchGate(same);
    expect(invalid.verdict.checks.find((c) => c.kind === "reports")?.status).toBe("insufficient");
    await expect(f.client.benchGate({ ...input, child: child.revision })).rejects.toThrow(
      "same revision",
    );
  });
  it("records stale CLI conditions and inherited leakage rather than accepting them", async () => {
    const f = setup();
    const stale = revisionOf({ ...child.basis, cliVersion: "2.0" });
    f.target.b.revisions.candidate = stale;
    f.save();
    const result = await f.client.benchGate({ ...f.input(), child: stale.revision });
    expect(result.verdict.decision).toBe("insufficient");
    expect(result.verdict.checks.find((c) => c.kind === "conditions")?.reason).toContain(
      "rerun the parent",
    );
    const g = setup();
    const leaked = method(g.target.ra).entries[0];
    assert(leaked);
    g.target.b.spec.lineage.candidate = { parent: parent.revision, informedBy: [leaked.trial] };
    g.save();
    const r = await g.client.benchGate(g.input());
    expect(r.verdict.inputs.taskSets[0]?.excluded).toContainEqual({
      task: leaked.task,
      trial: leaked.trial,
      revision: child.revision,
    });
  });
});

describe("gate CLI", () => {
  it("loads relative task files and explicit references, returning distinct decision exit codes", async () => {
    const f = setup();
    f.save();
    const file = join(f.root, "gate.yaml");
    writeFileSync(file, stringify(f.policy));
    writeFileSync(join(f.root, "gate.txt"), f.evidence.taskSets[0]?.content ?? "");
    writeFileSync(join(f.root, "refs.json"), JSON.stringify(f.evidence.selections));
    let record: GateRecord | undefined;
    const execute = async () => {
      const program = new Command();
      registerBench(
        program,
        async () => f.client,
        (_json, data) => {
          record = data as GateRecord;
        },
      );
      await program.parseAsync(
        [
          "bench",
          "gate",
          "--policy",
          file,
          "--parent",
          parent.revision,
          "--child",
          child.revision,
          "--reports",
          join(f.root, "refs.json"),
          "--json",
        ],
        { from: "user" },
      );
    };
    await execute();
    expect(record?.verdict.decision).toBe("accept");
    expect(process.exitCode).toBe(0);
    for (const c of method(f.target.rb).costs ?? []) c.wallSeconds = 100;
    f.target.rb.revision++;
    const refs = structuredClone(f.evidence.selections);
    assert(refs[0]);
    refs[0].child.revision = f.target.rb.revision;
    writeFileSync(join(f.root, "refs.json"), JSON.stringify(refs));
    f.store.addReport(f.target.rb);
    await execute();
    expect(process.exitCode).toBe(2);
    for (const c of method(f.target.rb).costs ?? []) c.wallSeconds = null;
    f.target.rb.revision++;
    refs[0].child.revision = f.target.rb.revision;
    writeFileSync(join(f.root, "refs.json"), JSON.stringify(refs));
    f.store.addReport(f.target.rb);
    await execute();
    expect(process.exitCode).toBe(3);
    writeFileSync(file, "version: 1\nversion: 1\n");
    expect(() => readGateInput(file, parent.revision, child.revision)).toThrow();
  });
});
