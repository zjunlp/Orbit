import { describe, expect, it } from "vitest";
import { ATIF_WRITE_VERSION, AtifOrbit, AtifTrajectory } from "../src/contracts/atif.ts";

function item<T>(items: T[], index = 0): T {
  const value = items[index];
  if (value === undefined) throw new Error("Missing test item");
  return value;
}

function trajectory(version = ATIF_WRITE_VERSION): AtifTrajectory {
  return {
    schema_version: version,
    session_id: "session",
    agent: { name: "test-agent", version: "1" },
    steps: [{ step_id: 1, source: "user", message: "test" }],
  };
}

function toolStep(): AtifTrajectory["steps"][number] {
  return {
    step_id: 2,
    source: "agent",
    message: "",
    tool_calls: [{ tool_call_id: "call-1", function_name: "echo", arguments: { text: "test" } }],
    observation: { results: [{ source_call_id: "call-1", content: "test" }] },
    llm_call_count: 1,
    metrics: { prompt_tokens: 10, completion_tokens: 3, cached_tokens: 4 },
  };
}

describe("ATIF contracts", () => {
  it.each(["ATIF-v1.5", "ATIF-v1.6", "ATIF-v1.7", "ATIF-v1.8"] as const)(
    "reads %s and preserves provider metadata",
    (schema_version) => {
      const input = {
        ...trajectory(),
        schema_version,
        extra: { provider: { nested: [1, "test"] } },
      };
      expect(AtifTrajectory.parse(input)).toEqual(input);
    },
  );

  it("reads nullable optional fields emitted by Harbor model_dump", () => {
    const input = {
      ...trajectory(),
      session_id: null,
      trajectory_id: null,
      notes: null,
      continued_trajectory_ref: null,
      final_metrics: null,
      subagent_trajectories: null,
      extra: null,
      agent: {
        name: "test-agent",
        version: "1",
        model_name: null,
        tool_definitions: null,
        extra: null,
      },
      steps: [
        {
          step_id: 1,
          source: "user",
          message: [{ type: "text", text: "test", source: null }],
          timestamp: null,
          model_name: null,
          reasoning_effort: null,
          reasoning_content: null,
          tool_calls: null,
          observation: null,
          metrics: null,
          is_copied_context: null,
          llm_call_count: null,
          extra: null,
        },
      ],
    };
    expect(AtifTrajectory.parse(input)).toEqual(input);
  });

  it("rejects unknown versions and unrecognized protocol fields without stripping them", () => {
    expect(AtifTrajectory.safeParse({ ...trajectory(), schema_version: "ATIF-v1.9" }).success).toBe(
      false,
    );
    expect(AtifTrajectory.safeParse({ ...trajectory(), invented: true }).success).toBe(false);
    const input = trajectory();
    input.steps.push({ ...toolStep(), metrics: { ...toolStep().metrics, invented: 4 } } as never);
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
  });

  it("enforces step ordering, agent-only fields, deterministic dispatch and local call pairing", () => {
    const input = trajectory();
    input.steps.push(toolStep());
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
    input.steps[1] = { ...toolStep(), step_id: 3 };
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    input.steps[1] = { ...toolStep(), source: "user" };
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    input.steps[1] = { ...toolStep(), llm_call_count: 0 };
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    input.steps[1] = { ...toolStep(), observation: { results: [{ source_call_id: "missing" }] } };
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    input.steps[1] = {
      ...toolStep(),
      tool_calls: [...(toolStep().tool_calls ?? []), ...(toolStep().tool_calls ?? [])],
    };
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    input.steps[1] = { ...toolStep(), metrics: undefined, llm_call_count: 0 };
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
  });

  it("allows truncated calls without inventing results", () => {
    const input = trajectory();
    input.steps.push({ ...toolStep(), observation: undefined });
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
  });

  it("accepts shared session identities but requires unique embedded trajectory IDs", () => {
    const child = { ...trajectory(), trajectory_id: "child-1" };
    const input = {
      ...trajectory(),
      subagent_trajectories: [child, { ...child, trajectory_id: "child-2" }],
    };
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
    input.subagent_trajectories[1] = child;
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    expect(
      AtifTrajectory.safeParse({ ...trajectory(), subagent_trajectories: [trajectory()] }).success,
    ).toBe(false);
  });

  it("resolves embedded references and allows explicit external file references", () => {
    const input: AtifTrajectory = {
      ...trajectory(),
      subagent_trajectories: [{ ...trajectory(), trajectory_id: "child" }],
    };
    const reference = { trajectory_id: "child", trajectory_path: undefined as string | undefined };
    input.steps.push({
      ...toolStep(),
      observation: { results: [{ subagent_trajectory_ref: [reference] }] },
    });
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
    reference.trajectory_id = "absent";
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    reference.trajectory_path = "child.json";
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
  });

  it("keeps legacy session-only subagent refs readable and requires resolvable modern refs", () => {
    const input = trajectory();
    input.steps.push({
      ...toolStep(),
      observation: { results: [{ subagent_trajectory_ref: [{ session_id: "child" }] }] },
    });
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    expect(AtifTrajectory.safeParse({ ...input, schema_version: "ATIF-v1.6" }).success).toBe(true);
    input.steps[1] = {
      ...toolStep(),
      observation: {
        results: [
          { subagent_trajectory_ref: [{ session_id: "child", trajectory_path: "child.json" }] },
        ],
      },
    };
    expect(AtifTrajectory.safeParse(input).success).toBe(true);
    expect(AtifTrajectory.safeParse({ ...trajectory(), session_id: undefined }).success).toBe(true);
    expect(
      AtifTrajectory.safeParse({
        ...trajectory(),
        schema_version: "ATIF-v1.5",
        session_id: undefined,
      }).success,
    ).toBe(false);
  });

  it("reads v1.6 images and v1.8 audio without accepting mismatched media", () => {
    const input = trajectory();
    item(input.steps).message = [
      { type: "image", source: { media_type: "image/png", path: "media/image.png" } },
    ];
    expect(AtifTrajectory.safeParse({ ...input, schema_version: "ATIF-v1.6" }).success).toBe(true);
    expect(AtifTrajectory.safeParse({ ...input, schema_version: "ATIF-v1.5" }).success).toBe(false);
    item(input.steps).message = [
      { type: "audio", source: { media_type: "audio/mpeg", path: "media/audio.mp3" } },
    ];
    expect(AtifTrajectory.safeParse(input).success).toBe(false);
    expect(AtifTrajectory.safeParse({ ...input, schema_version: "ATIF-v1.8" }).success).toBe(true);
    const malformed = {
      ...input,
      schema_version: "ATIF-v1.8",
      steps: [
        {
          step_id: 1,
          source: "user",
          message: [{ type: "image", source: { media_type: "audio/wav", path: "audio.wav" } }],
        },
      ],
    };
    expect(AtifTrajectory.safeParse(malformed).success).toBe(false);
    item(item(malformed.steps).message).type = "audio";
    item(item(malformed.steps).message).source.media_type = "audio/mp3";
    const parsed = AtifTrajectory.parse(malformed);
    expect(item(parsed.steps).message).toEqual([
      { type: "audio", source: { media_type: "audio/mpeg", path: "audio.wav" } },
    ]);
  });

  it("validates Orbit provenance while preserving other extra fields", () => {
    const orbit = AtifOrbit.parse({
      version: 1,
      importer: { name: "codex-rollout", version: 1 },
      sources: [{ path: "agent/session.jsonl", sha256: "0".repeat(64), bytes: 1 }],
      completeness: "agent-only",
    });
    const input = { ...trajectory(), extra: { orbit, upstream: true } };
    expect(AtifTrajectory.parse(input)).toEqual(input);
    expect(
      AtifTrajectory.safeParse({
        ...input,
        extra: { orbit: { ...orbit, completeness: "guessed" } },
      }).success,
    ).toBe(false);
    expect(
      AtifOrbit.safeParse({
        ...orbit,
        sources: [{ path: "session", sha256: "not-a-hash", bytes: -1 }],
      }).success,
    ).toBe(false);
  });
});
