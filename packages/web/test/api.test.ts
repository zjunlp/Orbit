import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/lib/api.ts";
import { readRunFile } from "../src/lib/run-file.ts";

afterEach(() => vi.unstubAllGlobals());

it("submits the reviewed evaluation with its folder and preserves adapter capabilities", async () => {
  const metadata = {
    tasks: [],
    metrics: [],
    capabilities: {
      kind: "browser",
      methods: ["empty"],
      conditions: { maxSteps: "20" },
      scoreKind: "binary",
      rescore: "evidence",
    },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(metadata)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "job-id" })));
  vi.stubGlobal("fetch", fetch);
  expect(await api.benchInfo("mini/wob")).toEqual(metadata);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/benchmarks/mini%2Fwob/tasks");
  const spec = {
    benchmark: "miniwob",
    tasks: ["click"],
    methods: [{ name: "empty", agent: "empty" as const }],
    seeds: 3,
    options: {},
  };
  await api.benchSubmit(spec, "gui/checks");
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/v1/bench/jobs?folder=gui%2Fchecks");
  expect(fetch.mock.calls[1]?.[1].method).toBe("POST");
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual(spec);
});

it("carries the consolidation preview digest through the Web API", async () => {
  const plan = {
    digest: "a".repeat(64),
    dryRun: true,
    adopted: [],
    reclassified: [],
    removedJobs: [],
    removedRuns: [],
    leftovers: [],
  };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(plan)));
  vi.stubGlobal("fetch", fetch);
  const preview = await api.benchConsolidate("target", { sources: ["source"] });
  fetch.mockResolvedValue(new Response(JSON.stringify({ ...plan, dryRun: false })));
  await api.benchConsolidate("target", {
    sources: ["source"],
    dryRun: false,
    expect: preview.digest,
  });
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({
    sources: ["source"],
    dryRun: false,
    expect: plan.digest,
  });
});

it("loads every cursor page instead of silently capping the run list", async () => {
  const runs = Array.from({ length: 1125 }, (_, i) => ({ id: `run-${i}` }));
  const cursor = { id: "run-999", createdAt: "2026-10-16T00:00:00.000Z" };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ runs: runs.slice(0, 1000), next: cursor })),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ runs: runs.slice(1000), next: null })));
  vi.stubGlobal("fetch", fetch);
  expect(await api.allRuns()).toEqual(runs);
  expect(fetch).toHaveBeenCalledTimes(2);
  const url = new URL(fetch.mock.calls[1]?.[0], "http://orbit.test");
  expect(JSON.parse(url.searchParams.get("before") ?? "")).toEqual(cursor);
});

it("passes cancellation through conversation and Trial reads, including raw files", async () => {
  const controller = new AbortController();
  const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    expect(init.signal).toBe(controller.signal);
    return new Response("null");
  });
  vi.stubGlobal("fetch", fetch);
  const signal = controller.signal;
  await api.run("run", signal);
  await api.benchJob("job", signal);
  await api.artifacts("run", signal);
  await api.session("run", signal);
  await api.trajectory("run", signal);
  await api.environment("run", "conversation.json", "conversation", "solve", signal);
  expect(await readRunFile("run", "conversation.json", "the conversation", 1024, signal)).toBe(
    "null",
  );
  expect(fetch).toHaveBeenCalledTimes(7);
});

it("propagates aborted response-body reads without wrapping them as HTTP failures", async () => {
  const aborted = new DOMException("Cancelled body", "AbortError");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(aborted),
      text: () => Promise.reject(aborted),
    }),
  );
  await expect(api.session("run")).rejects.toBe(aborted);
  await expect(readRunFile("run", "conversation.json", "the conversation")).rejects.toBe(aborted);
});

it("reads filtered transfer evidence with cancellation through the daemon API", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ rows: [], columns: [], omitted: [] })),
    );
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await api.benchTransfer({ parentBundle: "a".repeat(64), childBundle: "b".repeat(64) }, signal);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe(
    `/api/v1/bench/transfer?parentBundle=${"a".repeat(64)}&childBundle=${"b".repeat(64)}`,
  );
  expect(init.signal).toBe(signal);
  expect(init.method ?? "GET").toBe("GET");
});
