import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { ScoreResult } from "../../../packages/orbit/src/contracts/index.ts";
import { wandrScore } from "./adapter.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-wandr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

it("keeps all WANDR metrics and refuses missing, inconsistent and failed judgements", () => {
  const output = join(root, "wandr");
  const dir = join(output, "after/logs/verifier");
  const values = Object.fromEntries(
    [
      "soft_precision",
      "soft_recall",
      "soft_f1",
      "hard_precision",
      "hard_recall",
      "hard_f1",
    ].flatMap((metric) => ["full", "retrieval"].map((lineage) => [`${metric}_${lineage}`, 0.25])),
  );
  write(join(dir, "reward.json"), JSON.stringify({ ...values, reward: 0.25 }));
  const result = ScoreResult.parse(wandrScore(output, "after"));
  expect(result).toMatchObject({ score: 0.25, invalid: false, metrics: { soft_recall_full: 25 } });
  expect(Object.keys(result.metrics ?? {})).toHaveLength(12);
  write(join(dir, "reward.json"), JSON.stringify({ reward: 0 }));
  expect(wandrScore(output, "after").invalid).toBe(true);
  write(join(dir, "reward.json"), JSON.stringify({ ...values, reward: 0.5 }));
  expect(wandrScore(output, "after").invalid).toBe(true);
  write(join(dir, "reward.json"), JSON.stringify({ ...values, reward: 0.25 }));
  write(join(dir, "error.json"), '{"error":"API failed"}');
  expect(wandrScore(output, "after").score).toBeNull();
});
