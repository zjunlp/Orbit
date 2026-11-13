import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertCodexTrajectory } from "../src/sessions/codex.ts";

const event = (type: string, payload: unknown, extra = {}) => ({ type, payload, ...extra });
const item = (payload: unknown, extra = {}) => event("response_item", payload, extra);
const message = (role: string, value: unknown = "fixture") =>
  item({
    type: "message",
    role,
    content: typeof value === "string" ? [{ type: "output_text", text: value }] : value,
  });
const usage = (input: number, output: number, totalInput = input, totalOutput = output) =>
  event("event_msg", {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output,
      },
      total_token_usage: {
        input_tokens: totalInput,
        cached_input_tokens: 0,
        output_tokens: totalOutput,
        reasoning_output_tokens: 0,
        total_tokens: totalInput + totalOutput,
      },
    },
  });
const convert = (...events: unknown[]) =>
  convertCodexTrajectory(events.map((value) => JSON.stringify(value)).join("\n"));
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/atif/${name}`, import.meta.url));

describe("Codex ATIF conversion", () => {
  it("matches the sanitized native-session golden", async () => {
    const input = await readFile(fixture("codex.jsonl"), "utf8");
    const expected: unknown = JSON.parse(await readFile(fixture("codex.expected.json"), "utf8"));
    expect(convertCodexTrajectory(input)).toEqual(expected);
  });

  it("groups parallel tools into one model call and pairs out-of-order results", () => {
    const { trajectory } = convert(
      message("user"),
      item({
        type: "function_call",
        call_id: "a",
        namespace: "functions",
        name: "shell",
        arguments: '{"cmd":"first"}',
      }),
      item({ type: "custom_tool_call", call_id: "b", name: "exec", input: "second" }),
      usage(100, 20),
      item({ type: "custom_tool_call_output", call_id: "b", output: "second result" }),
      item({ type: "function_call_output", call_id: "a", output: "first result" }),
    );
    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps[1]?.tool_calls?.map((call) => call.tool_call_id)).toEqual(["a", "b"]);
    expect(trajectory.steps[1]?.tool_calls?.[0]?.arguments).toEqual({ cmd: "first" });
    expect(trajectory.steps[1]?.tool_calls?.[1]?.arguments).toEqual({ input: "second" });
    expect(
      trajectory.steps[1]?.observation?.results.map((result) => result.source_call_id),
    ).toEqual(["b", "a"]);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(100);
  });

  it("counts repeated usage notifications once, including notifications before the next response", () => {
    const first = usage(100, 20);
    const { trajectory } = convert(
      message("assistant", "first"),
      first,
      first,
      message("assistant", "second"),
      first,
      usage(100, 20, 200, 40),
    );
    expect(trajectory.steps).toHaveLength(2);
    expect(trajectory.steps.map((step) => step.metrics?.prompt_tokens)).toEqual([100, 100]);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(200);
  });

  it("does not invent missing usage or present a partial sum as the total", () => {
    const { trajectory } = convert(
      message("assistant", "first"),
      usage(100, 20),
      message("assistant", "unmetered"),
    );
    expect(trajectory.final_metrics?.total_prompt_tokens).toBeUndefined();
    expect(trajectory.steps[0]?.metrics?.prompt_tokens).toBe(100);
    expect(trajectory.steps[1]?.metrics).toBeUndefined();
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
  });

  it("preserves zero usage and complete long content", () => {
    const value = "x".repeat(12000);
    const { trajectory } = convert(message("assistant", value), usage(0, 0));
    expect(trajectory.steps[0]?.message).toBe(value);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(0);
  });

  it("retains unknown events and flags broken input instead of silently skipping it", () => {
    const { trajectory } = convertCodexTrajectory(
      `${JSON.stringify(message("user"))}\n{broken\n${JSON.stringify(event("future_event", { retained: true }))}`,
    );
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
    expect(trajectory.extra?.orbit?.unknown_events).toEqual(
      expect.arrayContaining([
        { line: 2, type: "invalid-json" },
        { line: 3, type: "future_event", value: event("future_event", { retained: true }) },
      ]),
    );
  });

  it("keeps encrypted reasoning opaque, including a supplied summary", () => {
    const { trajectory } = convert(
      item({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "signed summary" }],
        encrypted_content: "opaque-fixture",
      }),
      message("assistant"),
      usage(10, 2),
    );
    expect(trajectory.steps[0]?.reasoning_content).toBeUndefined();
    expect(trajectory.steps[0]?.extra?.orbit?.reasoning).toBe("opaque");
    expect(JSON.stringify(trajectory)).not.toContain("opaque-fixture");
    expect(JSON.stringify(trajectory)).not.toContain("signed summary");
  });

  it("keeps a mixed reasoning step opaque regardless of item order", () => {
    for (const summaries of [false, true]) {
      const raw = item({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "must not leak" }],
      });
      const opaque = item({ type: "reasoning", encrypted_content: "opaque-fixture" });
      const { trajectory } = convert(
        ...(summaries ? [raw, opaque] : [opaque, raw]),
        message("assistant"),
        usage(10, 2),
      );
      expect(trajectory.steps[0]?.reasoning_content).toBeUndefined();
      expect(trajectory.steps[0]?.extra?.orbit?.reasoning).toBe("opaque");
    }
  });

  it("retains unsigned reasoning summaries", () => {
    const { trajectory } = convert(
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "short summary" }] }),
      message("assistant"),
      usage(10, 2),
    );
    expect(trajectory.steps[0]?.reasoning_content).toBe("short summary");
    expect(trajectory.steps[0]?.extra?.orbit?.reasoning).toBe("summary");
  });

  it("emits context replacement boundaries and tolerates reset usage counters", () => {
    const { trajectory } = convert(
      message("assistant", "before"),
      usage(100, 20),
      event("compacted", { message: "condensed context" }),
      message("assistant", "after"),
      usage(100, 20),
    );
    expect(trajectory.steps[1]?.extra?.context_management).toEqual({
      type: "compaction",
      boundary: "replace",
    });
    expect(trajectory.steps[1]?.observation?.results[0]?.content).toBe("condensed context");
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(200);
  });

  it("returns media separately and uses relative references in the trajectory", () => {
    const { trajectory, media } = convert(
      message("user", [
        { type: "input_text", text: "image" },
        { type: "input_image", image_url: "data:image/png;base64,aGk=" },
      ]),
    );
    expect(media).toHaveLength(1);
    expect(media[0]?.base64).toBe("aGk=");
    expect(trajectory.steps[0]?.message).toEqual([
      { type: "text", text: "image" },
      { type: "image", source: { media_type: "image/png", path: media[0]?.path } },
    ]);
    expect(JSON.stringify(trajectory)).not.toContain("base64");
  });

  it("marks missing, duplicate and orphan tool results without inventing calls", () => {
    const { trajectory } = convert(
      message("user"),
      item({ type: "function_call", call_id: "a", name: "shell", arguments: "{}" }),
      item({ type: "function_call_output", call_id: "orphan", output: "unmatched" }),
      usage(10, 2),
    );
    expect(trajectory.steps[1]?.tool_calls).toHaveLength(1);
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
    expect(trajectory.extra?.orbit?.unknown_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "orphan_tool_result" }),
        expect.objectContaining({ type: "missing_tool_result" }),
      ]),
    );
  });

  it("excludes the copied parent prefix from subagent accounting", () => {
    const { trajectory } = convert(
      event("session_meta", {
        id: "child",
        cli_version: "fixture",
        source: { subagent: { thread_spawn: {} } },
        subagent_history_start_ordinal: 4,
      }),
      message("assistant", "copied"),
      { ...usage(100, 20), ordinal: 2 },
      { ...message("assistant", "own"), ordinal: 4 },
      { ...usage(10, 2), ordinal: 5 },
    );
    // A prefix without ordinals cannot be classified safely.
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
  });

  it("accounts only for subagent events after a known prefix boundary", () => {
    const { trajectory } = convert(
      event("session_meta", {
        id: "child",
        source: { subagent: { thread_spawn: {} } },
        subagent_history_start_ordinal: 4,
      }),
      { ...message("assistant", "copied"), ordinal: 1 },
      { ...usage(100, 20), ordinal: 2 },
      { ...message("assistant", "own"), ordinal: 4 },
      { ...usage(10, 2), ordinal: 5 },
    );
    expect(trajectory.steps).toHaveLength(1);
    expect(trajectory.steps[0]?.message).toBe("own");
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(10);
    expect(trajectory.extra?.orbit?.completeness).toBe("agent-only");
  });

  it("reports malformed timestamps without discarding otherwise usable content", () => {
    const { trajectory } = convert({ ...message("user"), timestamp: "Nov 12, 2026" });
    expect(trajectory.steps[0]?.timestamp).toBeUndefined();
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
  });

  it("rejects an empty rollout", () => {
    expect(() => convertCodexTrajectory("")).toThrow("no trajectory steps");
  });
});
