import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexCallText,
  codexOutputText,
  findClaudeSession,
  findCodexSession,
  loadRunAgentTranscript,
  loadTranscript,
  parseClaude,
  parseCodex,
  runAgentFailure,
} from "../src/sessions/index.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-sessions-"));
const roots = { claude: join(root, "claude"), codex: join(root, "codex") };
const jl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("claude code transcripts", () => {
  it("normalizes text, thinking, tool calls and results; skips sidechains", async () => {
    mkdirSync(join(roots.claude, "-p"), { recursive: true });
    const f = join(roots.claude, "-p", "0b6c2a1e-5f3d-4c7a-9e21-7d4b8f2a6c10.jsonl");
    writeFileSync(
      f,
      jl([
        { type: "mode" },
        { type: "user", timestamp: "t1", message: { content: "run a sweep" } },
        {
          type: "assistant",
          timestamp: "t2",
          message: {
            content: [
              { type: "thinking", thinking: "plan" },
              { type: "tool_use", id: "u1", name: "Bash", input: { command: "orbit run" } },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] },
        },
        { type: "assistant", isSidechain: true, message: { content: "hidden" } },
      ]),
    );
    const m = await parseClaude(f);
    expect(m.map((x) => `${x.role}/${x.kind}/${x.name ?? ""}`)).toEqual([
      "user/text/",
      "assistant/thinking/",
      "assistant/tool_call/Bash",
      "tool/tool_result/Bash",
    ]);
    const t = await loadTranscript(
      { harness: "claude-code", sessionId: "0b6c2a1e-5f3d-4c7a-9e21-7d4b8f2a6c10" },
      roots,
    );
    expect(t?.messages).toHaveLength(4);
    expect(await findClaudeSession(roots, "../-p/0b6c2a1e-5f3d-4c7a-9e21-7d4b8f2a6c10")).toBeNull();
  });
});

describe("codex transcripts", () => {
  it("finds a session by cwd and parses response items", async () => {
    const d = join(roots.codex, "2026", "09", "30");
    mkdirSync(d, { recursive: true });
    const f = join(d, "rollout-2026-09-30T10-00-00-abc.jsonl");
    writeFileSync(
      f,
      jl([
        { type: "session_meta", payload: { id: "abc", cwd: "/proj" } },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        },
        {
          type: "response_item",
          payload: { type: "function_call", name: "shell", call_id: "c1", arguments: "{}" },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", call_id: "c1", output: "done" },
        },
        { type: "event_msg", payload: { type: "token_count" } },
      ]),
    );
    expect(await findCodexSession(roots, { cwd: "/proj" })).toEqual({ file: f, sessionId: "abc" });
    expect(await findCodexSession(roots, { cwd: "/other" })).toBeNull();
    const m = await parseCodex(f);
    expect(m.map((x) => `${x.kind}/${x.name ?? ""}`)).toEqual([
      "text/",
      "tool_call/shell",
      "tool_result/shell",
    ]);
  });

  it("unwraps the JS exec tool of newer Codex versions", () => {
    const js =
      'await Promise.all([tools.exec_command({cmd:"orbit ps -g \\"a b\\"",max:1}), tools.exec_command({ cmd: "ls" })])';
    expect(codexCallText(js)).toBe('$ orbit ps -g "a b"\n$ ls');
    expect(codexCallText("print(1)")).toBe("print(1)");
    const out = [
      { type: "input_text", text: "Script completed" },
      {
        type: "input_text",
        text: JSON.stringify({ i: 0, value: { exit_code: 0, output: "ok\n" } }),
      },
      {
        type: "input_text",
        text: JSON.stringify({ i: 1, value: { exit_code: 2, output: "bad" } }),
      },
    ];
    expect(codexOutputText(out)).toBe("Script completed\nok\n\n[exit 2]\nbad");
    expect(codexOutputText({ content: "x" })).toBe("x");
    const bare = {
      type: "input_text",
      text: JSON.stringify({ chunk_id: "c", exit_code: 0, output: "[]" }),
    };
    expect(codexOutputText([bare])).toBe("[]");
  });
});

describe("sessions of the Agent inside a run", () => {
  it("loads the newest Codex or Claude Code transcript from the run's Agent home", async () => {
    const agent = join(root, "run-agent");
    expect(await loadRunAgentTranscript(agent)).toBeNull();
    const codexDir = join(agent, "codex", "sessions", "2026", "10", "03");
    mkdirSync(codexDir, { recursive: true });
    const id = "01a100f0-5e45-7542-badf-61943b49d4bf";
    const f = join(codexDir, `rollout-2026-10-03T08-45-24-${id}.jsonl`);
    writeFileSync(
      f,
      jl([
        { type: "session_meta", payload: { id, cwd: "/task" } },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        },
      ]),
    );
    const t = await loadRunAgentTranscript(agent);
    expect(t).toMatchObject({ harness: "codex", sessionId: id, file: f });
    expect(t?.messages.map((m) => m.text)).toEqual(["go"]);

    // Claude Code: <home>/projects/<escaped cwd>/<id>.jsonl; subagent transcripts are skipped.
    const proj = join(agent, "claude", "projects", "-task");
    mkdirSync(join(proj, "subagents"), { recursive: true });
    const row = { type: "user", timestamp: "t", message: { content: "hello" } };
    writeFileSync(join(proj, "subagents", "agent-x.jsonl"), jl([row]));
    rmSync(join(agent, "codex"), { recursive: true });
    writeFileSync(join(proj, "abc-def-123456.jsonl"), jl([row]));
    expect(await loadRunAgentTranscript(agent)).toMatchObject({
      harness: "claude-code",
      sessionId: "abc-def-123456",
    });
  });
});

describe("how the Agent inside a run ended", () => {
  const startupError =
    "Error loading config.toml: Failed to read config file /orbit/agent/codex/config.toml: Permission denied (os error 13)";

  it("recognizes a pre-session Codex config permission failure before after-phase output", async () => {
    const agent = join(root, "fail-codex-startup");
    const log = join(root, "startup-log.txt");
    writeFileSync(log, `${startupError}\n`);
    expect(await runAgentFailure(agent, log)).toBeNull();
    mkdirSync(join(agent, "codex"), { recursive: true });
    writeFileSync(join(agent, "codex", "config.toml"), "");
    expect(await runAgentFailure(agent, log)).toEqual({
      kind: "agent_configuration_failed",
      message: startupError,
    });
    writeFileSync(
      log,
      `WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)\n${startupError}\n\n[orbit] after phase output:\n${"verifier output\n".repeat(2000)}`,
    );
    expect(
      await runAgentFailure(agent, log, (text) => text.replace("/orbit/agent/codex", "[redacted]")),
    ).toEqual({
      kind: "agent_configuration_failed",
      message: startupError.replace("/orbit/agent/codex", "[redacted]"),
    });
  });

  it("does not infer startup failure from ordinary, quoted or incomplete log output", async () => {
    const agent = join(root, "codex-startup-lookalikes");
    const log = join(root, "startup-lookalikes.txt");
    mkdirSync(join(agent, "codex"), { recursive: true });
    writeFileSync(join(agent, "codex", "config.toml"), "");
    for (const text of [
      "Permission denied (os error 13)",
      `tool output:\n${startupError}`,
      `${startupError}\nmodel answered successfully`,
      startupError.replace("/orbit/agent/codex/config.toml", "/workspace/config.toml"),
      `${"x".repeat(16 * 1024)}\n${startupError}`,
      `${startupError}\n${" ".repeat(16 * 1024)}`,
    ]) {
      writeFileSync(log, text);
      expect(await runAgentFailure(agent, log)).toBeNull();
    }
  });

  it("preserves model work when its transcript exists despite a startup-looking log", async () => {
    const agent = join(root, "codex-startup-model-work");
    const log = join(root, "startup-model-work.txt");
    const dir = join(agent, "codex", "sessions", "2026", "11", "06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(agent, "codex", "config.toml"), "");
    writeFileSync(log, `${startupError}\n`);
    writeFileSync(
      join(dir, "rollout.jsonl"),
      jl([
        { type: "event_msg", payload: { type: "task_started" } },
        { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      ]),
    );
    expect(await runAgentFailure(agent, log)).toBeNull();
  });

  it("reports a Codex turn that ended on a credential or quota error, not earlier retries", async () => {
    const agent = join(root, "fail-codex");
    expect(await runAgentFailure(agent)).toBeNull();
    const dir = join(agent, "codex", "sessions", "2026", "10", "04");
    mkdirSync(dir, { recursive: true });
    const done = (error: unknown) => ({
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: null, error },
    });
    const f = join(dir, "rollout-a.jsonl");
    writeFileSync(
      f,
      jl([
        { type: "session_meta", payload: {} },
        done({ message: "401 Unauthorized: invalid_api_key" }),
      ]),
    );
    expect(await runAgentFailure(agent)).toEqual({
      kind: "model_authentication_failed",
      message: "401 Unauthorized: invalid_api_key",
    });
    // A later turn that finished normally wins; an ordinary failure is the method's result.
    writeFileSync(f, jl([done({ message: "usage limit" }), done(null)]));
    expect(await runAgentFailure(agent)).toBeNull();
    writeFileSync(f, jl([done({ message: "tool crashed" })]));
    expect(await runAgentFailure(agent)).toBeNull();
  });

  it("uses the structured Codex error and catches a turn stopped while reconnecting", async () => {
    const agent = join(root, "fail-codex-open");
    const dir = join(agent, "codex", "sessions", "2026", "10", "13");
    mkdirSync(dir, { recursive: true });
    const ev = (payload: unknown) => ({ type: "event_msg", payload });
    const f = join(dir, "rollout-b.jsonl");
    writeFileSync(
      f,
      jl([
        ev({ type: "task_started" }),
        ev({
          type: "task_complete",
          error: {
            message: "boom",
            codex_error_info: { http_connection_failed: { http_status_code: 401 } },
          },
        }),
      ]),
    );
    expect(await runAgentFailure(agent)).toEqual({
      kind: "model_authentication_failed",
      message: "boom",
    });
    // The turn never completed: only the run log can tell whether the model was the problem.
    writeFileSync(f, jl([ev({ type: "task_started" }), ev({ type: "item_completed" })]));
    const log = join(root, "open-log.txt");
    expect(await runAgentFailure(agent, log)).toBeNull();
    writeFileSync(log, "+ python train.py\nepoch 3 loss 0.2\n");
    expect(await runAgentFailure(agent, log)).toBeNull();
    writeFileSync(
      log,
      [
        "epoch 3 loss 0.2",
        "2026-10-13T11:55:27Z ERROR codex_models_manager::manager: failed to refresh available models: Connection failed: error sending request",
        "ERROR: Reconnecting... waiting for network",
        "ERROR: Reconnecting... waiting for network",
        "",
      ].join("\n"),
    );
    expect(await runAgentFailure(agent, log)).toEqual({
      kind: "model_unreachable",
      message:
        "stopped while reconnecting to the model: ERROR: Reconnecting... waiting for network",
    });
    writeFileSync(log, "ERROR: unexpected status 401 Unauthorized\nERROR: Reconnecting... 2/5\n");
    expect(await runAgentFailure(agent, log)).toMatchObject({
      kind: "model_authentication_failed",
    });
    // A later turn that started again resets an earlier error.
    writeFileSync(
      f,
      jl([
        ev({ type: "task_complete", error: { message: "usage limit" } }),
        ev({ type: "task_started" }),
      ]),
    );
    writeFileSync(log, "done\n");
    expect(await runAgentFailure(agent, log)).toBeNull();
  });

  it("reports a Claude Code final API error only before any model reply", async () => {
    const agent = join(root, "fail-claude");
    const dir = join(agent, "claude", "projects", "-task");
    mkdirSync(dir, { recursive: true });
    const reply = (text: string, api: boolean) => ({
      type: "assistant",
      isApiErrorMessage: api,
      message: { content: [{ type: "text", text }] },
    });
    const f = join(dir, "0b6c2a1e-5f3d-4c7a-9e21-7d4b8f2a6c11.jsonl");
    writeFileSync(f, jl([reply("Credit balance is too low", true)]));
    expect(await runAgentFailure(agent)).toMatchObject({ kind: "model_quota_exhausted" });
    writeFileSync(f, jl([reply("working", false), reply("Credit balance is too low", true)]));
    expect(await runAgentFailure(agent)).toBeNull();
    writeFileSync(f, jl([reply("Credit balance is too low", true), reply("done", false)]));
    expect(await runAgentFailure(agent)).toBeNull();
    writeFileSync(f, jl([{ ...reply("API Error", true), error: "authentication_failed" }]));
    expect(await runAgentFailure(agent)).toMatchObject({ kind: "model_authentication_failed" });
  });
});
