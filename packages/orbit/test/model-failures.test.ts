// Synthetic, credential-free fixtures in the native Codex and Claude Code transcript formats.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { agentErrorKind } from "../src/harness/index.ts";
import { Redactor } from "../src/lib/redact.ts";
import { runAgentFailure } from "../src/sessions/index.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-model-failures-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
let count = 0;
const event = (payload: unknown) => ({ type: "event_msg", payload });
const item = (payload: unknown) => ({ type: "response_item", payload });
const codexError = (message: string, codex_error_info?: unknown) =>
  event({ type: "task_complete", error: { message, codex_error_info } });
const claudeError = (text: string, error?: unknown) => ({
  type: "assistant",
  isApiErrorMessage: true,
  error,
  message: { content: [{ type: "text", text }] },
});
function transcript(agent: "codex" | "claude", rows: unknown[]) {
  const root = join(home, String(count++));
  const dir = join(root, agent, agent === "codex" ? "sessions/2026/11/04" : "projects/-task");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return root;
}

describe("final model failures before any successful response", () => {
  it.each([
    ["Unauthorized", undefined, "model_authentication_failed"],
    ["API Error: 401", undefined, "model_authentication_failed"],
    ["invalid api key", undefined, "model_authentication_failed"],
    ["API Error", "Unauthorized", "model_authentication_failed"],
    ["API Error", "authentication_error", "model_authentication_failed"],
    ["connect ECONNREFUSED 127.0.0.1:1", undefined, "model_unreachable"],
    ["TypeError: fetch failed", undefined, "model_unreachable"],
    ["stream disconnected before completion", undefined, "model_unreachable"],
    ["API Error", "api_connection_error", "model_unreachable"],
  ])("classifies the native error %s (%s)", async (message, code, kind) => {
    expect(agentErrorKind(message as string, code)).toBe(kind);
    for (const agent of ["codex", "claude"] as const) {
      const root = transcript(agent, [
        agent === "codex"
          ? codexError(message as string, code)
          : claudeError(message as string, code),
      ]);
      expect(await runAgentFailure(root)).toMatchObject({ kind });
    }
  });

  it.each([
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }),
    item({ type: "function_call", name: "shell", arguments: "{}" }),
    item({ type: "custom_tool_call", name: "exec", input: "true" }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "I will inspect it." }] }),
    item({ type: "reasoning", encrypted_content: "fixture-encrypted-response" }),
    event({ type: "agent_message", message: "Done" }),
    event({ type: "agent_reasoning", text: "I will inspect it." }),
    event({ type: "task_complete", last_agent_message: "Done", error: null }),
  ])("keeps Codex partial model work scoreable: %#", async (response) => {
    const root = transcript("codex", [
      event({ type: "task_started" }),
      response,
      codexError("stream disconnected"),
    ]);
    expect(await runAgentFailure(root)).toBeNull();
    const log = join(root, "log");
    writeFileSync(log, "ERROR: Reconnecting... 5/5\n");
    const reconnecting = transcript("codex", [response, event({ type: "task_started" })]);
    expect(await runAgentFailure(reconnecting, log)).toBeNull();
  });

  it.each([
    "I choose to finish without acting.",
    [{ type: "text", text: "The endpoint returned 401 Unauthorized." }],
    [{ type: "thinking", thinking: "I will inspect the screenshot." }],
    [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "true" } }],
  ])("keeps Claude partial model work scoreable: %#", async (content) => {
    const root = transcript("claude", [
      { type: "assistant", message: { content } },
      claudeError("fetch failed"),
    ]);
    expect(await runAgentFailure(root)).toBeNull();
  });

  it.each([
    [{ message: "401 Invalid token", status: 401 }, "model_authentication_failed"],
    [{ status: 401 }, "model_authentication_failed"],
    [{ status: 403, formatted: "Authentication refused" }, "model_authentication_failed"],
    [{ formatted: "401 Invalid token" }, "model_authentication_failed"],
    [{ message: "fetch failed", status: null }, "model_unreachable"],
  ])(
    "recognizes Claude system API retries before any successful response: %#",
    async (error, kind) => {
      const root = transcript("claude", [
        { type: "system", subtype: "api_error", error, retryAttempt: 1 },
        { type: "system", subtype: "api_error", error, retryAttempt: 2 },
        { type: "last-prompt", lastPrompt: "Complete the task" },
        { type: "cost-state", cost: 0 },
      ]);
      expect(await runAgentFailure(root)).toMatchObject({ kind });
    },
  );

  it.each([true, false])(
    "keeps Claude system API failures scoreable when a reply exists (reply first: %s)",
    async (first) => {
      const response = {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done" }] },
      };
      const failure = { type: "system", subtype: "api_error", error: { status: 401 } };
      const root = transcript("claude", first ? [response, failure] : [failure, response]);
      expect(await runAgentFailure(root)).toBeNull();
    },
  );

  it("ignores Claude sidechain, user and unrelated system API error lookalikes", async () => {
    const error = { message: "401 Invalid token", status: 401 };
    for (const rows of [
      [{ type: "system", subtype: "api_error", error, isSidechain: true }],
      [{ type: "system", subtype: "other", error }],
      [{ type: "user", subtype: "api_error", error }],
      [
        {
          type: "user",
          message: { content: [{ type: "tool_result", content: JSON.stringify(error) }] },
        },
      ],
      [{ type: "last-prompt" }, { type: "cost-state", cost: 0 }],
      [
        { type: "system", subtype: "api_error", error },
        {
          type: "system",
          subtype: "api_error",
          error: { status: 400, message: "Invalid request shape" },
        },
      ],
    ])
      expect(await runAgentFailure(transcript("claude", rows))).toBeNull();
  });

  it("redacts Claude system API errors before clipping", async () => {
    const secret = `fixture-not-a-key-${"x".repeat(240)}`;
    const redactor = new Redactor([secret]);
    const root = transcript("claude", [
      {
        type: "system",
        subtype: "api_error",
        error: { status: 401, message: `Invalid token: ${secret}` },
      },
    ]);
    expect(await runAgentFailure(root, undefined, (text) => redactor.apply(text))).toEqual({
      kind: "model_authentication_failed",
      message: "Invalid token: [redacted]",
    });
  });

  it("ignores user/tool error text and unrelated terminal errors", async () => {
    for (const agent of ["codex", "claude"] as const) {
      const rows =
        agent === "codex"
          ? [
              item({ type: "message", role: "user", content: [{ text: "401 Unauthorized" }] }),
              item({ type: "function_call_output", call_id: "fixture", output: "fetch failed" }),
              codexError("tool exited with code 1"),
            ]
          : [
              { type: "user", message: { content: "401 Unauthorized" } },
              {
                type: "user",
                message: { content: [{ type: "tool_result", content: "fetch failed" }] },
              },
            ];
      const root = transcript(agent, rows);
      const log = join(root, "log");
      writeFileSync(log, "fetch failed\nexit code 1; no actions\n");
      expect(await runAgentFailure(root, log)).toBeNull();
    }
  });

  it("does not count prompts, tool output or Claude sidechains as successful replies", async () => {
    const codex = transcript("codex", [
      item({ type: "message", role: "user", content: [{ text: "Done" }] }),
      item({ type: "function_call_output", output: "Done" }),
      codexError("Unauthorized"),
    ]);
    const claude = transcript("claude", [
      { type: "assistant", isSidechain: true, message: { content: "Done" } },
      claudeError("Unauthorized"),
      { ...claudeError("ignored sidechain"), isSidechain: true },
    ]);
    expect(await runAgentFailure(codex)).toMatchObject({ kind: "model_authentication_failed" });
    expect(await runAgentFailure(claude)).toMatchObject({ kind: "model_authentication_failed" });
  });

  it("clears an earlier retried error and never infers failure without a transcript", async () => {
    const root = transcript("codex", [
      codexError("Unauthorized"),
      event({ type: "task_complete", error: null }),
    ]);
    expect(await runAgentFailure(root)).toBeNull();
    const log = join(root, "log");
    writeFileSync(log, "ERROR: Reconnecting... 5/5\n");
    expect(await runAgentFailure(join(root, "missing"), log)).toBeNull();
    expect(await runAgentFailure(transcript("claude", []), log)).toBeNull();
  });

  it.each([
    "Failed to refresh token status=403 Forbidden",
    "Failed to refresh token: Failed to refresh token: 403 Forbidden",
  ])("recognizes Codex native token refresh rejection in an open turn: %s", async (error) => {
    const root = transcript("codex", [event({ type: "task_started" })]);
    const log = join(root, "log");
    writeFileSync(log, `2026-11-04T00:00:00.123456Z ERROR codex_login::auth::manager: ${error}\n`);
    expect(await runAgentFailure(root, log)).toEqual({
      kind: "model_authentication_failed",
      message: "model login token refresh rejected (403 Forbidden)",
    });
  });

  it("does not use token refresh stderr after successful work or a completed turn", async () => {
    for (const rows of [
      [
        item({ type: "message", role: "assistant", content: [{ text: "Done" }] }),
        event({ type: "task_started" }),
      ],
      [event({ type: "task_started" }), event({ type: "task_complete", error: null })],
    ]) {
      const root = transcript("codex", rows);
      const log = join(root, "log");
      writeFileSync(
        log,
        "2026-11-04T00:00:00Z ERROR codex_login::auth::manager: Failed to refresh token status=403 Forbidden\n",
      );
      expect(await runAgentFailure(root, log)).toBeNull();
    }
  });

  it("ignores token refresh text from tools, generic 403s and earlier stderr", async () => {
    const native =
      "2026-11-04T00:00:00Z ERROR codex_login::auth::manager: Failed to refresh token status=403 Forbidden";
    const root = transcript("codex", [
      event({ type: "task_started" }),
      item({ type: "function_call_output", output: native }),
      item({ type: "message", role: "user", content: [{ text: native }] }),
    ]);
    const log = join(root, "log");
    for (const text of [
      "403 Forbidden",
      `quoted tool output: ${native}`,
      native.replace("codex_login::auth::manager", "another_client::auth"),
      `${native}\nfinished without an error`,
    ]) {
      writeFileSync(log, `${text}\n`);
      expect(await runAgentFailure(root, log)).toBeNull();
    }
  });

  it("uses structured errors even when the CLI records no message text", async () => {
    const codex = transcript("codex", [codexError("", "Unauthorized")]);
    const claude = transcript("claude", [
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "authentication_error",
        message: { content: [] },
      },
    ]);
    for (const root of [codex, claude])
      expect(await runAgentFailure(root)).toEqual({
        kind: "model_authentication_failed",
        message: "API error",
      });
  });

  it("redacts known secrets before truncating a failure message", async () => {
    const secret = `fixture-not-a-key-${"x".repeat(240)}`;
    const redactor = new Redactor([secret]);
    const root = transcript("codex", [codexError(`Unauthorized: ${secret}`)]);
    expect(await runAgentFailure(root, undefined, (text) => redactor.apply(text))).toEqual({
      kind: "model_authentication_failed",
      message: "Unauthorized: [redacted]",
    });
  });
});
