import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConversationTrajectory, type ScoreResult, type ServiceSpec } from "../contracts/index.ts";

const PREFIX = "orbit-textarena: ";
const PREVIEW_LIMIT = 2 * 1024 * 1024;
const LOG_LIMIT = 16 * 1024 * 1024;

// Installed only in the protected game sidecar, before the upstream server's unchanged main block.
const RECORDER = `
def _orbit_install_recorder():
    _step = _env.step
    _json = Handler._json
    _bytes = 0
    _stopped = False

    def record(event, **data):
        nonlocal _bytes, _stopped
        if _stopped:
            return
        try:
            line = json.dumps(dict(version=1, event=event, **data), default=str)
            size = len(line.encode("utf-8"))
            if size > 200000 or _bytes + size > 8388608:
                _stopped = True
                line = '{"version":1,"event":"truncated"}'
            _bytes += size
            print("orbit-textarena: " + line, flush=True)
        except Exception:
            _stopped = True

    def step(action):
        record("action", action=action)
        return _step(action=action)

    def response(self, code, data):
        result = _json(self, code, data)
        path = self.path.split("?")[0]
        if path == "/action":
            record("response", code=code, observation=data.get("observation"), done=data.get("done"))
        elif path == "/result" and code in (200, 425):
            record("result", code=code)
        return result

    _env.step = step
    Handler._json = response
    record("start", environment=ENV_ID, observation=_observation)

try:
    _orbit_install_recorder()
except Exception:
    pass

`;

/** Keep unknown server variants untouched; recording is optional and never changes the game API. */
export function textarenaService(service: ServiceSpec, staging: string): ServiceSpec {
  if (service.name !== "game" || !service.dockerfile || service.command || service.entrypoint)
    return service;
  try {
    const dockerfile = readFileSync(service.dockerfile, "utf8");
    if (
      !/^COPY\s+game_server\.py\s+\/app\/game_server\.py\s*$/m.test(dockerfile) ||
      !/^CMD\s+\["python3",\s*"\/app\/game_server\.py"\]\s*$/m.test(dockerfile) ||
      service.binds.some((bind) => "/app/game_server.py".startsWith(bind.target))
    )
      return service;
    const source = readFileSync(
      join(service.context ?? dirname(service.dockerfile), "game_server.py"),
      "utf8",
    );
    const main = '\nif __name__ == "__main__":';
    if (
      source.split(main).length !== 2 ||
      !source.includes("done, _ = _env.step(action=action)") ||
      !source.includes("def _json(self, code, data):") ||
      !source.includes("_player_id, _observation = _env.get_observation()")
    )
      return service;
    mkdirSync(staging, { recursive: true });
    const target = join(staging, "textarena-game-server.py");
    writeFileSync(target, source.replace(main, `${RECORDER}${main}`), { mode: 0o600 });
    return {
      ...service,
      binds: [...service.binds, { source: target, target: "/app/game_server.py", mode: "ro" }],
    };
  } catch {
    return service;
  }
}

function observation(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    Array.isArray(value) &&
    value.every((item) => Array.isArray(item) && typeof item[1] === "string")
  )
    return value.map((item) => item[1]).join("\n\n");
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Native observations/actions only; the saved verifier reward remains the sole verdict. */
export function importTextarenaConversation(
  log: string,
  score: ScoreResult,
): ConversationTrajectory {
  const turns: ConversationTrajectory["turns"] = [];
  let started = false;
  let finished = false;
  let truncated = false;
  let pending = false;
  let budget = 0;
  let goal = "TextArena game";
  const append = (actor: string, text: string) => {
    if (!text || truncated) return;
    const event = { type: "message" as const, actor, text };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (text.length > 200_000 || budget + bytes > PREVIEW_LIMIT - 32_768) {
      truncated = true;
      return;
    }
    budget += bytes;
    turns.at(-1)?.events.push(event);
  };
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith(PREFIX)) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line.slice(PREFIX.length));
    } catch {
      truncated = true;
      continue;
    }
    if (row?.version !== 1) throw new Error("unsupported TextArena recording");
    if (row.event === "start") {
      if (started) throw new Error("multiple TextArena games in one recording");
      started = true;
      goal = typeof row.environment === "string" ? row.environment.slice(0, 100_000) : goal;
      turns.push({ index: 0, events: [] });
      append("environment", observation(row.observation));
    } else if (!started) {
      truncated = true;
    } else if (row.event === "action") {
      if (pending) truncated = true;
      if (turns.at(-1)?.events.some((event) => event.actor === "agent")) {
        if (turns.length >= 1000) truncated = true;
        else if (!truncated) turns.push({ index: turns.length, events: [] });
      }
      if (typeof row.action !== "string") throw new Error("invalid recorded TextArena action");
      append("agent", row.action);
      pending = true;
    } else if (row.event === "response") {
      if (row.code === 200) {
        if (!pending) truncated = true;
        append("environment", observation(row.observation));
        finished = row.done === true;
        pending = false;
      }
    } else if (row.event === "truncated") truncated = true;
  }
  if (!started) throw new Error("no recorded game moves; rerun to capture a conversation");
  const passed = score.invalid || score.score === null ? null : score.score >= score.maxScore;
  return ConversationTrajectory.parse({
    version: 1,
    kind: "conversation",
    goal,
    participants: [
      { id: "agent", role: "agent", label: "Player" },
      { id: "environment", role: "environment", label: "TextArena" },
    ],
    turns,
    verdict: {
      passed,
      type: "TextArena reward",
      scorer: "Harbor TextArena verifier",
      message:
        passed === null
          ? "The verifier did not produce a valid reward."
          : `Reward: ${score.score} / ${score.maxScore}`,
      explanation:
        "The saved verifier reward determines the result. Game messages are review evidence; no per-move correctness is inferred.",
      checks: [],
    },
    producer: "sidecar",
    trust: "trusted",
    completeness: truncated || pending || !finished ? "truncated" : "environment-only",
  });
}

/** Adapter-owned review output in the existing solve artifact directory. */
export async function addTextarenaConversation(output: string, score: ScoreResult): Promise<void> {
  const relative = "services/game/log";
  try {
    let current = output;
    for (const [index, part] of ["", "services", "game", "log"].entries()) {
      current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index === 3 ? !info.isFile() : !info.isDirectory()))
        throw new Error("game log must be a regular collected file");
      if (index === 3 && info.size > LOG_LIMIT) throw new Error("game log exceeds import limit");
    }
    score.review ??= { files: [], items: [], details: {} };
    score.review.files.push({
      label: "Game service log",
      phase: "solve",
      path: relative,
      kind: "text",
    });
    const file = await open(current, "r");
    let log: string;
    try {
      const bytes = Buffer.alloc(LOG_LIMIT + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > LOG_LIMIT) throw new Error("game log exceeds import limit");
      log = bytes.subarray(0, count).toString("utf8");
    } finally {
      await file.close();
    }
    const trace = importTextarenaConversation(log, score);
    const text = JSON.stringify(trace);
    if (Buffer.byteLength(text) > PREVIEW_LIMIT)
      throw new Error("conversation exceeds preview limit");
    const temp = join(output, `.orbit-conversation-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { mode: 0o600, flag: "wx" });
      await rename(temp, join(output, "orbit-conversation.json"));
    } finally {
      await rm(temp, { force: true });
    }
    score.review.files.push({
      label: "Game conversation",
      phase: "solve",
      path: "orbit-conversation.json",
      kind: "conversation",
      fallback: "json",
    });
  } catch (error) {
    score.issues.push(`TextArena conversation: ${(error as Error).message}`);
  }
}
