import { BenchJobDetail, type ConversationTrajectory, Run } from "@zjunlp/orbit/contracts";

export type LongConversation = "many-turns" | "single-turn";

/** Invented, deterministic stress data; never a real Agent run or benchmark result. */
export function longConversation(sample: LongConversation): ConversationTrajectory {
  const turnCount = sample === "many-turns" ? 1000 : 1;
  const eventCount = sample === "many-turns" ? 10000 : 5000;
  const eventsPerTurn = eventCount / turnCount;
  return {
    version: 1,
    kind: "conversation",
    participants: [
      { id: "user", role: "user", label: "Synthetic user" },
      { id: "agent", role: "agent", label: "Synthetic agent" },
    ],
    turns: Array.from({ length: turnCount }, (_, index) => ({
      index,
      events: Array.from({ length: eventsPerTurn }, (_, eventIndex) => {
        const id = index * eventsPerTurn + eventIndex;
        return id % 2 === 0
          ? {
              type: "message" as const,
              actor: id % 4 === 0 ? "user" : "agent",
              text: `SYNTHETIC ${sample}: needle-event-${id}\n${"Variable height message with wrapping and multiple lines.\n".repeat(1 + (id % 5))}`,
            }
          : {
              type: "tool_call" as const,
              id: `call-${id}`,
              actor: "agent",
              name: "synthetic_lookup",
              arguments: { event: id, query: `needle-tool-${id}` },
              status: "ok" as const,
              result: {
                marker: `result-marker-${id}`,
                lines: Array.from({ length: 30 }, (_, i) => `Synthetic result line ${i}`),
              },
            };
      }),
      check: { status: turnCount > 1 && index === 850 ? ("failed" as const) : ("passed" as const) },
    })),
    verdict: {
      passed: turnCount === 1,
      failedTurn: turnCount > 1 ? 850 : undefined,
      checks: [],
      message: `SYNTHETIC TEST DATA — ${turnCount} turns / ${eventCount.toLocaleString("en-US")} events; no real evaluation.`,
    },
    completeness: "complete",
    producer: "verifier",
    trust: "trusted",
  };
}

export function conversationRun(id: string): Run {
  return Run.parse({
    reason: null,
    image: "synthetic",
    containerId: null,
    lease: null,
    note: "SYNTHETIC UI fixture",
    id,
    state: "succeeded",
    spec: {
      command: ["true"],
      image: "synthetic",
      resources: { gpus: 0, cpus: 1, memGB: 1 },
      tags: {},
    },
    cleanup: "done",
    createdAt: "2026-11-17T00:00:00Z",
    startedAt: "2026-11-17T00:00:00Z",
    endedAt: "2026-11-17T00:00:01Z",
    exitCode: 0,
    node: "synthetic",
    remote: false,
    code: null,
    usage: null,
    tokens: null,
    trajectory: null,
  });
}

export function conversationJob(): BenchJobDetail {
  return BenchJobDetail.parse({
    summary: [],
    job: {
      id: "synthetic-conversations",
      state: "done",
      spec: {
        name: "SYNTHETIC conversation UI fixtures",
        benchmark: "synthetic",
        methods: [{ name: "empty", agent: "empty" }],
        seeds: 1,
      },
      metrics: [],
      revisions: {},
      capabilities: { rescore: "none", methods: ["empty"], conditions: {}, scoreKind: "binary" },
      createdAt: "2026-11-17T00:00:00Z",
      endedAt: "2026-11-17T00:00:01Z",
    },
    trials: (["many-turns", "single-turn"] as const).map((id) => ({
      id,
      jobId: "synthetic-conversations",
      task: id,
      method: "empty",
      seed: 1,
      endedAt: "2026-11-17T00:00:01Z",
      state: "done",
      createdAt: "2026-11-17T00:00:00Z",
      solveRunId: `solve-${id}`,
      verifyRunId: `verify-${id}`,
      history: [],
      issues: [],
      outcome: {
        execution: "succeeded",
        cleanup: "done",
        evaluation: "valid",
        score: 0,
        maxScore: 1,
        issues: [],
        review: {
          files: [
            {
              phase: "verify",
              kind: "conversation",
              path: "conversation.json",
              label: "Synthetic conversation",
            },
          ],
          items: [],
          details: {},
        },
      },
    })),
  });
}
