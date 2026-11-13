import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AtifTrajectory } from "../src/contracts/atif.ts";
import { convertClaudeTrajectory } from "../src/sessions/claude.ts";

const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const usage = {
  input_tokens: 10,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
  output_tokens: 4,
};
const user = (uuid: string, parentUuid: string | null, content: unknown) => ({
  type: "user",
  uuid,
  parentUuid,
  sessionId: "session",
  version: "2.1.319",
  message: { role: "user", content },
});
const assistant = (
  uuid: string,
  parentUuid: string,
  id: string,
  content: unknown,
  metrics: unknown = usage,
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  sessionId: "session",
  version: "2.1.319",
  message: { role: "assistant", id, model: "fixture-model", content, usage: metrics },
});
const text = (value: string) => [{ type: "text", text: value }];
const call = (id = "call") => [
  { type: "tool_use", id, name: "Bash", input: { command: "printf fixture" } },
];
const result = (id = "call") => [
  { type: "tool_result", tool_use_id: id, content: "Fixture result" },
];
const convert = (rows: unknown[]) => convertClaudeTrajectory(jsonl(rows)).trajectory;

// Whitelisted records from a real Claude Run; text, inputs, ids, timestamps, model and usage replaced.
describe("Claude Code ATIF conversion", () => {
  it("matches the sanitized real-session golden output", () => {
    const input = readFileSync(new URL("fixtures/atif/claude.jsonl", import.meta.url), "utf8");
    const expected = JSON.parse(
      readFileSync(new URL("fixtures/atif/claude.atif.json", import.meta.url), "utf8"),
    );
    const { trajectory, media } = convertClaudeTrajectory(input);
    expect(trajectory).toEqual(expected);
    expect(AtifTrajectory.parse(trajectory)).toEqual(trajectory);
    expect(media).toEqual([]);
  });

  it("groups split model messages and attaches tool results to the initiating step", () => {
    const trajectory = convert([
      user("u", null, "Fixture request"),
      assistant("a1", "u", "model-call", text("Planning"), { ...usage, output_tokens: 1 }),
      assistant("a2", "a1", "model-call", call()),
      user("r", "a2", result()),
      assistant("a3", "r", "final-call", text("Done")),
    ]);
    expect(trajectory.steps).toHaveLength(3);
    expect(trajectory.steps[1]).toMatchObject({
      source: "agent",
      message: "Planning",
      metrics: { prompt_tokens: 15, completion_tokens: 4, cached_tokens: 3 },
      observation: { results: [{ source_call_id: "call", content: "Fixture result" }] },
    });
    expect(trajectory.final_metrics).toEqual({
      total_prompt_tokens: 30,
      total_completion_tokens: 8,
      total_cached_tokens: 6,
      total_steps: 3,
    });
    expect(AtifTrajectory.safeParse(trajectory).success).toBe(true);
  });

  it("retains parallel result siblings and split message siblings without restoring abandoned calls", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      assistant("abandoned", "u", "discarded-message", call("discarded"), {
        ...usage,
        output_tokens: 999,
      }),
      assistant("a1", "u", "parallel-message", call("c1"), { ...usage, output_tokens: 1 }),
      assistant("a2", "a1", "parallel-message", call("c2"), { ...usage, output_tokens: 2 }),
      assistant("a3", "a1", "parallel-message", call("c3")),
      user("r1", "a1", [
        ...result("c1"),
        ...result("discarded"),
        ...text("Abandoned sibling prompt"),
      ]),
      user("r2", "a2", result("c2")),
      user("r3", "a3", result("c3")),
      assistant("final", "r2", "final-message", text("Finished")),
    ]);
    expect(trajectory.steps).toHaveLength(3);
    expect(trajectory.steps[1]?.tool_calls?.map((item) => item.tool_call_id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(trajectory.steps[1]?.observation?.results.map((item) => item.source_call_id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(trajectory.final_metrics?.total_completion_tokens).toBe(8);
    expect(trajectory.extra?.orbit?.completeness).toBe("agent-only");
    expect(JSON.stringify(trajectory)).not.toContain("Abandoned sibling prompt");
    expect(AtifTrajectory.safeParse(trajectory).success).toBe(true);
  });

  it("selects the active parent chain and deduplicates UUIDs", () => {
    const abandoned = assistant("old", "u", "old-call", text("Abandoned"), {
      ...usage,
      output_tokens: 999,
    });
    const trajectory = convert([
      user("u", null, "Fixture"),
      abandoned,
      assistant("new", "u", "new-call", text("Accepted")),
      assistant("new", "u", "new-call", text("Accepted")),
    ]);
    expect(trajectory.steps.map((step) => step.message)).toEqual(["Fixture", "Accepted"]);
    expect(trajectory.final_metrics?.total_completion_tokens).toBe(4);
    expect(trajectory.extra?.orbit?.metadata?.excluded_branch_records).toBe(2);
  });

  it("follows logical parents across compaction and retains the summary as a system observation", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      assistant("a", "u", "m", text("Before")),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "c",
        parentUuid: null,
        logicalParentUuid: "a",
        compactMetadata: { trigger: "auto", preTokens: 100 },
      },
      { ...user("s", "c", "Condensed context"), isCompactSummary: true },
      assistant("b", "s", "n", text("After")),
    ]);
    expect(trajectory.steps).toHaveLength(4);
    expect(trajectory.steps[2]).toMatchObject({
      source: "system",
      extra: { context_management: { type: "compaction", boundary: "replace" } },
      observation: { results: [{ content: "Condensed context" }] },
    });
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(30);
  });

  it("resolves preserved UUID copies against the parent state before compaction", () => {
    const trajectory = convert([
      user("u", null, "Initial"),
      assistant("a", "u", "old", text("Old answer")),
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "boundary",
        parentUuid: null,
        logicalParentUuid: "a",
      },
      { ...user("summary", "boundary", "Summary"), isCompactSummary: true },
      user("u", "summary", "Initial"),
      assistant("a", "u", "old", text("Old answer")),
      assistant("last", "a", "new", text("New answer")),
    ]);
    expect(
      trajectory.steps.filter((step) => step.source === "agent").map((step) => step.message),
    ).toEqual(["Old answer", "New answer"]);
    expect(trajectory.steps.filter((step) => step.extra?.context_management)).toHaveLength(1);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(30);
    expect(trajectory.extra?.orbit?.completeness).toBe("agent-only");
  });

  it("omits opaque fields and inline media from unknown-event metadata", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      {
        type: "future",
        encrypted_content: "cipher-secret",
        nested: { signature: "signature-secret", type: "base64", data: "data-secret" },
        image: "data:image/png;base64,aGVsbG8=",
      },
      { type: "attachment", attachment: { signature: "attachment-signature" } },
    ]);
    const serialized = JSON.stringify(trajectory);
    for (const secret of [
      "cipher-secret",
      "signature-secret",
      "data-secret",
      "aGVsbG8=",
      "attachment-signature",
    ])
      expect(serialized).not.toContain(secret);
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
  });

  it("keeps signed reasoning opaque and preserves unsigned thinking", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      assistant("a", "u", "signed", [
        {
          type: "thinking",
          thinking: "Never expose this signed text",
          signature: "opaque-signature",
        },
        ...text("Visible"),
      ]),
      assistant("b", "a", "plain", [{ type: "thinking", thinking: "Readable thought" }]),
    ]);
    expect(trajectory.steps[1]?.reasoning_content).toBeUndefined();
    expect(trajectory.steps[1]?.extra?.orbit?.reasoning).toBe("opaque");
    expect(JSON.stringify(trajectory)).not.toContain("Never expose");
    expect(JSON.stringify(trajectory)).not.toContain("opaque-signature");
    expect(trajectory.steps[2]?.reasoning_content).toBe("Readable thought");
  });

  it("extracts image assets without putting base64 in the trajectory", () => {
    const { trajectory, media } = convertClaudeTrajectory(
      jsonl([
        user("u", null, [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ]),
        assistant("a", "u", "m", text("Seen")),
      ]),
    );
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ mediaType: "image/png", base64: "aGVsbG8=" });
    expect(trajectory.steps[0]?.message).toEqual([
      { type: "image", source: { media_type: "image/png", path: media[0]?.path } },
    ]);
    expect(JSON.stringify(trajectory)).not.toContain("aGVsbG8=");
  });

  it("embeds sidechains and counts their usage separately", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      assistant("a", "u", "m", call()),
      { ...user("cu", null, "Child request"), isSidechain: true, agentId: "child" },
      { ...assistant("ca", "cu", "cm", text("Child answer")), isSidechain: true, agentId: "child" },
      { ...user("r", "a", result()), toolUseResult: { agentId: "child" } },
    ]);
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(15);
    expect(trajectory.subagent_trajectories?.[0]?.final_metrics?.total_prompt_tokens).toBe(15);
    expect(trajectory.steps[1]?.observation?.results[0]?.subagent_trajectory_ref).toEqual([
      { trajectory_id: "session:agent:child" },
    ]);
    expect(AtifTrajectory.safeParse(trajectory).success).toBe(true);
  });

  it("keeps embedded-child source hashes and diagnostic lines tied to the complete input", () => {
    const input = jsonl([
      user("u", null, "Fixture"),
      assistant("a", "u", "m", text("Main")),
      { ...user("cu", null, "Child"), isSidechain: true, agentId: "child" },
      {
        ...assistant("ca", "cu", "cm", [{ type: "future_block" }]),
        isSidechain: true,
        agentId: "child",
      },
    ]);
    const { trajectory } = convertClaudeTrajectory(input);
    const child = trajectory.subagent_trajectories?.[0];
    expect(child?.extra?.orbit?.sources).toEqual(trajectory.extra?.orbit?.sources);
    expect(child?.steps[1]?.extra?.orbit?.native?.line).toBe(4);
    expect(child?.extra?.orbit?.unknown_events).toEqual([
      { line: 4, value: { type: "future_block" } },
    ]);
  });

  it("accepts separate sidechain files and preserves original source hashes", () => {
    const input = jsonl([
      user("u", null, "Fixture"),
      assistant("a", "u", "m", call()),
      user("r", "a", result()),
    ]);
    const child = `${jsonl([
      { ...user("cu", null, "Child"), isSidechain: true, agentId: "child" },
      { ...assistant("ca", "cu", "cm", text("Done")), isSidechain: true, agentId: "child" },
    ])}\n`;
    const { trajectory } = convertClaudeTrajectory(input, {
      subagents: [
        { input: child, agentId: "child", toolUseId: "call", sourcePath: "subagents/child.jsonl" },
      ],
    });
    expect(trajectory.subagent_trajectories?.[0]?.extra?.orbit?.sources[0]).toMatchObject({
      path: "subagents/child.jsonl",
      bytes: Buffer.byteLength(child),
    });
    expect(trajectory.steps[1]?.observation?.results[0]?.subagent_trajectory_ref).toHaveLength(1);
  });

  it("marks unknown events, malformed lines and missing tool output as truncated", () => {
    const { trajectory } = convertClaudeTrajectory(
      `${jsonl([user("u", null, "Fixture"), assistant("a", "u", "m", call()), { type: "future_event", value: 42 }])}\n{"incomplete"`,
    );
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
    expect(trajectory.extra?.orbit?.unknown_events).toEqual([
      { line: 3, value: { type: "future_event", value: 42 } },
    ]);
    expect(trajectory.extra?.orbit?.metadata?.conversion_issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "invalid-json" }),
        expect.objectContaining({ type: "missing_tool_result" }),
      ]),
    );
    expect(AtifTrajectory.safeParse(trajectory).success).toBe(true);
  });

  it("retains orphan tool feedback without inventing a model call", () => {
    const trajectory = convert([user("u", null, result("missing"))]);
    expect(trajectory.steps[0]).toMatchObject({
      source: "system",
      observation: {
        results: [{ content: "Fixture result", extra: { native_tool_use_id: "missing" } }],
      },
    });
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
  });

  it("preserves usable content when native timestamps violate the ATIF datetime contract", () => {
    for (const timestamp of [
      "2026-11-12",
      "Thu, 12 Nov 2026 12:00:00 GMT",
      "2026-02-30T12:00:00Z",
      "not-a-time",
    ]) {
      const trajectory = convert([
        { ...user("u", null, "Fixture request"), timestamp },
        {
          ...assistant("a", "u", "m", text("Fixture answer")),
          timestamp: "2026-11-12T12:00:00+08:00",
        },
      ]);
      expect(trajectory.steps[0]?.message).toBe("Fixture request");
      expect(trajectory.steps[0]?.timestamp, timestamp).toBeUndefined();
      expect(trajectory.steps[1]?.timestamp).toBe("2026-11-12T12:00:00+08:00");
      expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
      expect(trajectory.extra?.orbit?.metadata?.conversion_issues).toContainEqual({
        line: 1,
        type: "invalid_timestamp",
      });
      expect(AtifTrajectory.safeParse(trajectory).success, timestamp).toBe(true);
    }
  });

  it("does not account synthetic API errors as model usage", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      { ...assistant("a", "u", "m", text("API error")), isApiErrorMessage: true },
    ]);
    expect(trajectory.steps[1]?.source).toBe("system");
    expect(trajectory.steps[1]?.metrics).toBeUndefined();
    expect(trajectory.final_metrics?.total_prompt_tokens).toBe(0);
  });

  it("does not report unknown or incomplete usage as zero", () => {
    const trajectory = convert([
      user("u", null, "Fixture"),
      assistant("a", "u", "m", text("No usage"), null),
    ]);
    expect(trajectory.extra?.orbit?.completeness).toBe("truncated");
    expect(trajectory.final_metrics?.total_prompt_tokens).toBeUndefined();
    const partial = convert([
      user("u", null, "Fixture"),
      assistant("a", "u", "m", text("Partial usage"), { output_tokens: 2 }),
    ]);
    expect(partial.steps[1]?.metrics?.prompt_tokens).toBeUndefined();
    expect(partial.steps[1]?.metrics?.completion_tokens).toBe(2);
    expect(partial.final_metrics?.total_prompt_tokens).toBeUndefined();
  });

  it("rejects empty or non-conversation input", () => {
    expect(() => convertClaudeTrajectory("")).toThrow("no convertible");
    expect(() => convert([{ type: "cost-state" }])).toThrow("no convertible");
  });
});
