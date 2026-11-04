import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { efeActions, importEfeTrajectory } from "../src/bench/trajectory.ts";
import { addEfeTrajectory } from "../src/bench/trajectory-artifacts.ts";
import {
  type Run,
  RunSpec,
  type ScoreResult,
  type SessionMessage,
} from "../src/contracts/index.ts";

const final = {
  protocol: "eai-standard/2.1",
  tool: "mw_tool",
  control_steps: 2,
  finalized: true,
  reason: "finalize",
  final_reward: 4.5,
};
const journal = [
  { ev: "observe", call: 1, ts: 1000, control_steps: 0 },
  { ev: "submit", call: 2, ts: 1002, control_steps: 2 },
]
  .map((row) => JSON.stringify(row))
  .join("\n");
const messages: SessionMessage[] = [
  {
    at: new Date(999_000).toISOString(),
    role: "assistant",
    kind: "thinking",
    text: "Inspect the camera",
  },
  {
    at: new Date(1001_000).toISOString(),
    role: "assistant",
    kind: "tool_call",
    name: "Bash",
    text: "robot.submit(...)",
  },
];
// An explicit numpy.savez-format fixture: one uncompressed little-endian float64 matrix.
function archive() {
  const header = Buffer.from("{'descr': '<f8', 'fortran_order': False, 'shape': (2, 4), }\n");
  const npy = Buffer.alloc(10 + header.length + 64);
  Buffer.from("934e554d50590100", "hex").copy(npy);
  npy.writeUInt16LE(header.length, 8);
  header.copy(npy, 10);
  for (let i = 0; i < 8; i++) npy.writeDoubleLE(i / 10, 10 + header.length + i * 8);
  const name = Buffer.from("actions.npy");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(npy.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(30 + name.length + npy.length, 16);
  return Buffer.concat([local, name, npy, central, name, end]);
}
const input = () => ({
  goal: "Assembly fixture",
  journal,
  final,
  actions: efeActions(archive()),
  messages,
  video: "services/sim/data/replay.mp4",
});

describe("EFE trajectory import", () => {
  it("aligns executed actions, journal chunks, final reward, session references and the render clock", () => {
    const trace = importEfeTrajectory(input());
    expect(trace.completeness).toBe("complete");
    expect(trace.samples.at(-1)).toMatchObject({
      time: 0.025,
      action: [0.4, 0.5, 0.6, 0.7],
      reward: 4.5,
      terminated: true,
      sessionMessageIndexes: [1],
    });
    expect(trace.samples[0]?.sessionMessageIndexes).toEqual([0]);
    expect(trace.chunks).toEqual([{ start: 0, end: 0.025, label: "Call 2" }]);
    expect(trace.cameras[0]?.video?.timeMap).toEqual([
      { time: 0, videoTime: 0 },
      { time: 0.025, videoTime: 0.04 },
    ]);
    expect(trace.proprioNames).toEqual([]);
  });
  it("maps the final rendered frame even when the last step is outside the capture stride", () => {
    for (const count of [1, 3]) {
      const trace = importEfeTrajectory({
        ...input(),
        journal: "",
        final: { ...final, control_steps: count },
        actions: Array.from({ length: count }, () => [0, 0, 0, 0]),
      });
      expect(trace.cameras[0]?.video?.timeMap?.at(-1)).toEqual({
        time: count * 0.0125,
        videoTime: Math.ceil(count / 2) / 25,
      });
    }
  });
  it("marks missing sessions or incomplete records without inventing state", () => {
    expect(importEfeTrajectory({ ...input(), messages: [] }).completeness).toBe("environment-only");
    const trace = importEfeTrajectory({
      ...input(),
      actions: undefined,
      video: undefined,
      final: { ...final, finalized: false },
    });
    expect(trace.completeness).toBe("truncated");
    expect(trace.actionNames).toEqual([]);
    expect(trace.cameras).toEqual([]);
    expect(trace.samples.at(-1)?.truncated).toBe(true);
    expect(
      importEfeTrajectory({ ...input(), final: { ...final, reason: "timeout" } }).samples.at(-1),
    ).toMatchObject({ truncated: true, terminated: false });
  });
  it("rejects bad archives, inconsistent actions and backwards journal steps", () => {
    expect(() => efeActions(Buffer.from("not an archive"))).toThrow();
    expect(() => importEfeTrajectory({ ...input(), actions: [] })).toThrow(/step count/);
    expect(() =>
      importEfeTrajectory({
        ...input(),
        journal: `${journal}\n${JSON.stringify({ ev: "observe", control_steps: 1, ts: 1003 })}`,
      }),
    ).toThrow(/ordering/);
  });
  it("writes a review artifact through the scoring path and isolates import failures from scores", async () => {
    const output = await mkdtemp(join(tmpdir(), "orbit-trajectory-test-"));
    const data = join(output, "services/sim/data");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "episode.jsonl"), journal);
    await writeFile(join(data, "final.json"), JSON.stringify(final));
    await writeFile(join(data, "trajectory.npz"), archive());
    const run = {
      spec: RunSpec.parse({
        image: "fixture",
        command: ["true"],
        services: [{ name: "sim", image: "fixture", collect: ["/data/episode.jsonl"] }],
      }),
    } as Run;
    const score: ScoreResult = { score: 0, maxScore: 1, invalid: false, issues: [] };
    const target = join(output, "agent-owned");
    await writeFile(target, "unchanged");
    await symlink(target, join(output, "orbit-trajectory.json"));
    await addEfeTrajectory(output, run, score, messages, "fixture");
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect(score.review?.files[0]).toMatchObject({ phase: "solve", kind: "episode" });
    expect(JSON.parse(await readFile(join(output, "orbit-trajectory.json"), "utf8")).kind).toBe(
      "episode",
    );
    const link = `${output}-link`;
    await symlink(output, link);
    const linkedScore: ScoreResult = { score: 0, maxScore: 1, invalid: false, issues: [] };
    await addEfeTrajectory(link, run, linkedScore, messages, "fixture");
    expect(linkedScore.issues?.[0]).toContain("real directory");
    expect(linkedScore.review).toBeUndefined();
    await writeFile(join(data, "trajectory.npz"), "broken");
    await addEfeTrajectory(output, run, score, messages, "fixture");
    expect(score).toMatchObject({ score: 0, invalid: false });
    expect(score.issues?.at(-1)).toContain("trajectory import:");
  });
});
