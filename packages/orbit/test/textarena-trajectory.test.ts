import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { handle } from "../src/bench/adapter.ts";
import { harborAdapter, harborSolveSpec, parseHarborTask } from "../src/bench/harbor.ts";
import {
  addTextarenaConversation,
  importTextarenaConversation,
  textarenaService,
} from "../src/bench/textarena-trajectory.ts";
import {
  ConversationTrajectory,
  type Run,
  RunSpec,
  type ScoreResult,
} from "../src/contracts/index.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-textarena-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const score = (value = 1): ScoreResult => ({
  score: value,
  maxScore: 1,
  invalid: false,
  issues: [],
});
const rows = (...events: object[]) =>
  events.map((row) => `orbit-textarena: ${JSON.stringify({ version: 1, ...row })}`).join("\n");
const start = {
  event: "start",
  environment: "Synthetic-v0",
  observation: [[-1, "Guess a number."]],
};
const log = rows(
  start,
  { event: "action", action: "[4]" },
  { event: "response", code: 200, observation: [[-1, "Try a larger number."]], done: false },
  { event: "action", action: "[7]" },
  { event: "response", code: 200, observation: null, done: true },
  { event: "result", code: 200 },
);

// Explicit test double: native simulator dependencies and HTTP are not involved in this check.
const server = `import json
ENV_ID = "Synthetic-v0"
class Environment:
    def get_observation(self):
        return 0, [[-1, "Guess a number."]]
    def step(self, action):
        if action == "error":
            raise ValueError("native error")
        return action == "[7]", {"native": True}
_env = Environment()
_player_id, _observation = _env.get_observation()
class Handler:
    def _json(self, code, data):
        print("native-response: " + json.dumps(data))
        return "native-return"
def play(action):
    done, _ = _env.step(action=action)
    return done
if __name__ == "__main__":
    handler = Handler()
    handler.path = "/action"
    assert not play("[4]")
    assert handler._json(200, {"observation": [[-1, "Try a larger number."]], "done": False}) == "native-return"
    assert play("[7]")
    handler._json(200, {"observation": None, "done": True})
    handler.path = "/result?token=private-test-token"
    handler._json(200, {"rewards": {"0": 1}})
    try:
        play("error")
    except ValueError as error:
        assert str(error) == "native error"
    else:
        raise AssertionError("native exception was swallowed")
`;

function task(name = "game", identity = "textarena/synthetic") {
  const path = join(root, name);
  mkdirSync(join(path, "environment"), { recursive: true });
  mkdirSync(join(path, "tests"));
  writeFileSync(join(path, "task.toml"), `[task]\nname = "${identity}"\n`);
  writeFileSync(join(path, "instruction.md"), "Play the synthetic game.");
  writeFileSync(join(path, "tests/test.sh"), "#!/bin/sh\ntrue\n");
  writeFileSync(join(path, "environment/Dockerfile"), "FROM fixture\n");
  writeFileSync(
    join(path, "environment/Dockerfile.game"),
    'FROM fixture\nCOPY game_server.py /app/game_server.py\nCMD ["python3", "/app/game_server.py"]\n',
  );
  writeFileSync(join(path, "environment/game_server.py"), server);
  writeFileSync(
    join(path, "environment/docker-compose.yaml"),
    "services:\n  main:\n    build: .\n  game:\n    build:\n      context: .\n      dockerfile: Dockerfile.game\n",
  );
  return parseHarborTask(path, name);
}

describe("TextArena conversation evidence", () => {
  it("preserves native observations and moves, using only the verifier reward as the verdict", () => {
    const trace = importTextarenaConversation(log, score(0.5));
    expect(ConversationTrajectory.parse(trace)).toEqual(trace);
    expect(trace.turns.map((turn) => turn.events)).toEqual([
      [
        { type: "message", actor: "environment", text: "Guess a number." },
        { type: "message", actor: "agent", text: "[4]" },
        { type: "message", actor: "environment", text: "Try a larger number." },
      ],
      [{ type: "message", actor: "agent", text: "[7]" }],
    ]);
    expect(trace.verdict).toMatchObject({ passed: false, message: "Reward: 0.5 / 1" });
    expect(trace.verdict.failedTurn).toBeUndefined();
    expect(trace.turns.every((turn) => !turn.check)).toBe(true);
    expect(trace.completeness).toBe("environment-only");
    expect(
      importTextarenaConversation(log, { ...score(), invalid: true }).verdict.passed,
    ).toBeNull();
  });

  it("labels unfinished or cut recordings and bounds long previews without inventing missing moves", () => {
    expect(
      importTextarenaConversation(rows(start, { event: "result", code: 425 }), score(0))
        .completeness,
    ).toBe("truncated");
    expect(importTextarenaConversation(`${log}\norbit-textarena: {`, score()).completeness).toBe(
      "truncated",
    );
    const long = rows(
      start,
      ...Array.from({ length: 1100 }, () => [
        { event: "action", action: "x".repeat(4000) },
        { event: "response", code: 200, done: false },
      ]).flat(),
    );
    const trace = importTextarenaConversation(long, score(0));
    expect(trace.completeness).toBe("truncated");
    expect(Buffer.byteLength(JSON.stringify(trace))).toBeLessThan(2 * 1024 * 1024);
    expect(trace.turns.length).toBeLessThan(1000);
    expect(() =>
      importTextarenaConversation("game_server: Synthetic-v0 ready on :8080", score()),
    ).toThrow(/rerun/);
  });

  it("stages guarded sidecar recording without modifying the benchmark or native API behavior", () => {
    const fixture = task();
    const spec = harborSolveSpec(fixture, { name: "empty", agent: "empty" }, join(root, "staging"));
    const game = spec.services?.find((service) => service.name === "game");
    const copy = game?.binds?.find((bind) => bind.target === "/app/game_server.py");
    expect(copy?.mode).toBe("ro");
    expect(readFileSync(join(fixture.dir, "environment/game_server.py"), "utf8")).toBe(server);
    const result = spawnSync("python3", ["-I", copy?.source as string], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const recorded = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("orbit-textarena: "));
    expect(recorded.join("\n")).not.toContain("private-test-token");
    expect(
      recorded.map((line) => JSON.parse(line.slice("orbit-textarena: ".length)).event),
    ).toEqual(["start", "action", "response", "action", "response", "result", "action"]);
    const native = fixture.compose?.services[0];
    expect(native).toBeDefined();
    expect(textarenaService({ ...native, command: ["custom-server"] } as never, root)).toEqual({
      ...native,
      command: ["custom-server"],
    });
    const other = task("other", "other/synthetic");
    expect(
      harborSolveSpec(other, { name: "empty", agent: "empty" }, join(root, "other-staging"))
        .services?.[0]?.binds,
    ).toEqual([]);
  });

  it("generates a conversation from saved shared-mode evidence and keeps legacy logs as raw evidence", async () => {
    const fixture = task("scoring");
    const output = join(root, "output");
    mkdirSync(join(output, "services/game"), { recursive: true });
    mkdirSync(join(output, "after/logs/verifier"), { recursive: true });
    writeFileSync(join(output, "services/game/log"), log);
    writeFileSync(join(output, "after/logs/verifier/reward.txt"), "1\n");
    const run = {
      spec: RunSpec.parse({
        image: "fixture",
        command: ["true"],
        services: [{ name: "game", image: "fixture" }],
        after: { command: ["true"], timeoutMin: 1 },
      }),
    } as Run;
    const request = {
      protocol: 1,
      op: "score",
      benchmark: { name: "synthetic", path: fixture.dir, config: {} },
      trial: { id: "t", task: "scoring", method: { name: "empty", agent: "empty" }, options: {} },
      solve: { run, output },
      verify: { run, output },
    };
    const result = (await handle(harborAdapter, request as never)) as ScoreResult;
    expect(result).toMatchObject({ score: 1, invalid: false });
    expect(result.review?.files.at(-1)).toMatchObject({
      phase: "solve",
      kind: "conversation",
      fallback: "json",
    });
    expect(
      JSON.parse(readFileSync(join(output, "orbit-conversation.json"), "utf8")).verdict.passed,
    ).toBe(true);
    const missingSource = {
      ...request,
      benchmark: { ...request.benchmark, path: join(root, "missing") },
    };
    expect(await handle(harborAdapter, missingSource as never)).toMatchObject({
      score: 1,
      invalid: false,
    });
    run.spec.services[0]?.binds.push({
      source: "/old-staging/textarena-game-server.py",
      target: "/app/game_server.py",
      mode: "ro",
    });
    const frozen = (await handle(harborAdapter, missingSource as never)) as ScoreResult;
    expect(frozen.review?.files.at(-1)?.kind).toBe("conversation");
    writeFileSync(join(output, "services/game/log"), "game_server: Synthetic-v0 ready on :8080\n");
    const legacy = (await handle(harborAdapter, request as never)) as ScoreResult;
    expect(legacy).toMatchObject({ score: 1, invalid: false });
    expect(legacy.review?.files.some((file) => file.kind === "conversation")).toBe(false);
    expect(legacy.review?.files.at(-1)?.kind).toBe("text");
    expect(legacy.issues[0]).toContain("rerun");
  });

  it("rejects linked input and atomically replaces a linked destination without following it", async () => {
    const output = join(root, "linked-output");
    mkdirSync(join(output, "services/game"), { recursive: true });
    writeFileSync(join(output, "services/game/log"), log);
    const target = join(root, "unrelated");
    writeFileSync(target, "keep");
    symlinkSync(target, join(output, "orbit-conversation.json"));
    await addTextarenaConversation(output, score());
    expect(readFileSync(target, "utf8")).toBe("keep");
    rmSync(join(output, "services/game/log"));
    symlinkSync(target, join(output, "services/game/log"));
    const rejected = score();
    await addTextarenaConversation(output, rejected);
    expect(rejected).toMatchObject({ score: 1, invalid: false });
    expect(rejected.review).toBeUndefined();
    expect(rejected.issues[0]).toContain("regular collected file");
  });
});
