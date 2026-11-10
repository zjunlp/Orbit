#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AdapterHandlers, handle } from "../../../packages/orbit/src/bench/adapter.ts";
import {
  harborAdapter,
  harborReview,
  harborReward,
} from "../../../packages/orbit/src/bench/harbor.ts";
import { AdapterRequest, type BenchTask } from "../../../packages/orbit/src/contracts/index.ts";

const SOURCES = {
  wandr: {
    revision: "9ea23c7f24d0aaabc2c87b26815a513001b2e7ce",
    path: "datasets/wandr",
    name: "WANDR",
  },
  frontierswe: {
    revision: "da83f84f8fbcec3cbf0f2b17c98ebc811355c2df",
    path: "tasks",
    name: "FrontierSWE v2",
  },
};
const REWARDS = [
  "soft_precision",
  "soft_recall",
  "soft_f1",
  "hard_precision",
  "hard_recall",
  "hard_f1",
].flatMap((metric) => ["full", "retrieval"].map((lineage) => `${metric}_${lineage}`));

function source(req: AdapterRequest) {
  const { suite, ...config } = req.benchmark.config;
  if (suite !== "wandr" && suite !== "frontierswe")
    throw new Error("suite must be wandr or frontierswe");
  const upstream = SOURCES[suite];
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", req.benchmark.path, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  if (git("rev-parse", "HEAD") !== upstream.revision)
    throw new Error(`${upstream.name}: checkout must be pinned to ${upstream.revision}`);
  git("diff", "--exit-code", "HEAD", "--", upstream.path);
  const ids = git("ls-tree", "-d", "--name-only", `HEAD:${upstream.path}`)
    .split("\n")
    .filter(Boolean);
  const path = join(req.benchmark.path, upstream.path);
  const incomplete = new Set<string>();
  if (suite === "frontierswe") {
    for (const file of git("ls-tree", "-r", "--name-only", `HEAD:${upstream.path}`).split("\n"))
      if (file && !existsSync(join(path, file))) incomplete.add(file.split("/")[0] as string);
  }
  return { suite, upstream, ids, config, path, incomplete };
}

function translated<T extends AdapterRequest>(req: T): T {
  const s = source(req);
  return { ...req, benchmark: { ...req.benchmark, path: s.path, config: s.config } };
}

export function wandrScore(output: string, sub: string) {
  const dir = join(output, sub, "logs", "verifier");
  const bad = (issue: string) => ({
    score: null,
    maxScore: 1,
    invalid: true,
    failure: "scorer_error" as const,
    issues: [issue],
    review: harborReview(output, sub),
  });
  if (existsSync(join(dir, "error.json")))
    return bad("Native WANDR verifier reported an error; no valid score");
  const base = harborReward(dir);
  if (base.invalid) return { ...base, review: harborReview(output, sub) };
  try {
    const values = JSON.parse(readFileSync(join(dir, "reward.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const metrics: Record<string, number> = {};
    for (const key of REWARDS) {
      const value = values[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        return bad(`Invalid or missing native WANDR reward: ${key}`);
      metrics[key] = value * 100;
    }
    if (base.score !== values.soft_recall_full)
      return bad("Primary WANDR reward disagrees with soft_recall_full");
    return { ...base, metrics, review: harborReview(output, sub) };
  } catch (error) {
    return bad(String(error));
  }
}

export const suiteAdapter: AdapterHandlers = {
  tasks(req) {
    const s = source(req);
    const found = new Map(harborAdapter.tasks(translated(req)).map((t) => [t.id, t]));
    return s.ids.map((id): BenchTask => {
      const task = found.get(id);
      if (!task || s.incomplete.has(id))
        return {
          id,
          title: id,
          supported: false,
          reason: "Pinned task files are absent; complete the source checkout",
          tags: { suite: s.suite },
        };
      const tags = { ...task.tags, suite: s.suite };
      return { ...task, tags };
    });
  },
  info(req, tasks) {
    const s = source(req);
    const base = harborAdapter.info?.(translated(req), tasks);
    return {
      ...base,
      capabilities: {
        ...base?.capabilities,
        identity: {
          id: s.suite === "frontierswe" ? "frontierswe-v2" : "wandr",
          name: s.upstream.name,
          version: s.upstream.revision,
        },
        category: "agent-workspace",
        profiles: [s.suite === "wandr" ? "research-report" : "terminal"],
        domains: [s.suite === "wandr" ? "research" : "coding"],
        methods: s.suite === "wandr" ? ["empty", "cli"] : ["empty", "oracle", "cli"],
        scoreKind: "scalar",
        rescore: "evidence",
        calibration: undefined,
        conditions: {
          Source: s.upstream.revision,
          Protocol: "Original task environments and verifiers through Orbit's Harbor adapter",
          ...(s.suite === "wandr"
            ? {
                Score: "Native soft_recall_full (relaxed recall); 12 native metrics retained",
                Judge:
                  "Original WANDR judge and page-fetch services required for nonempty submissions",
                Oracle: "No upstream reference solutions",
              }
            : {
                User: "Original agent account; root initializes the container and runs the independent verifier",
                Network:
                  "Allowlist egress requires explicit allowlistNetwork=public; recorded deviation, not official network parity",
              }),
        },
      },
      metrics:
        s.suite === "wandr"
          ? [
              { name: "score", label: "Relaxed recall", primary: true },
              ...REWARDS.map((name) => ({
                name,
                label: name.replaceAll("_", " "),
                unit: "%",
                range: [0, 100] as [number, number],
                primary: false,
              })),
            ]
          : harborAdapter.metrics,
      official: {
        name: `${s.upstream.name} task mean`,
        version: s.upstream.revision,
        unit: "task",
        errors: "exclude",
      },
    };
  },
  solve(req) {
    const s = source(req);
    if (s.suite === "wandr" && req.trial.method.agent === "oracle")
      throw new Error("WANDR publishes no oracle; use empty and real agent checks");
    if (s.incomplete.has(req.trial.task))
      throw new Error("Pinned task files are absent; complete the source checkout");
    const result = harborAdapter.solve(translated(req));
    if (s.suite === "frontierswe" && req.trial.method.agent === "oracle") {
      result.spec.env = { ...result.spec.env, HARBOR_ORACLE_FLAG: "1" };
      if (result.spec.after)
        result.spec.after.env = { ...result.spec.after.env, HARBOR_ORACLE_FLAG: "1" };
    }
    return result;
  },
  verify(req) {
    const result = harborAdapter.verify(translated(req));
    if (source(req).suite === "frontierswe" && req.trial.method.agent === "oracle")
      result.spec.env = { ...result.spec.env, HARBOR_ORACLE_FLAG: "1" };
    return result;
  },
  score(req) {
    const sub = req.verify.run.spec.after ? "after" : "collected";
    if (source(req).suite === "frontierswe") {
      const file = join(req.verify.output, sub, "logs", "verifier", "reward.json");
      if (existsSync(file)) {
        try {
          const values = JSON.parse(readFileSync(file, "utf8"));
          if (values.valid === 0 || values.valid === false)
            return {
              score: null,
              invalid: true,
              failure: "scorer_error",
              issues: ["Native FrontierSWE verifier marked the evidence invalid"],
              review: harborReview(req.verify.output, sub),
            };
        } catch {
          /* The original reward reader reports malformed JSON. */
        }
      }
    }
    return source(req).suite === "wandr"
      ? wandrScore(req.verify.output, req.verify.run.spec.after ? "after" : "collected")
      : harborAdapter.score(req);
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const req = AdapterRequest.parse(JSON.parse(readFileSync(0, "utf8")));
    if (req.op !== process.argv[2]) throw new Error("operation mismatch");
    process.stdout.write(`${JSON.stringify(handle(suiteAdapter, req))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
