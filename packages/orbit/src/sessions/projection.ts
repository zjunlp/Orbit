import type {
  AtifContentPart,
  AtifTrajectory,
  SessionMessage,
  SessionTranscript,
} from "../contracts/index.ts";

const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2);
/**
 * Newer Codex versions call tools through a JS `exec` tool (`tools.exec_command({cmd:"..."})`).
 * Show the shell commands it ran instead of the script when they can be extracted.
 */
export function codexCallText(input: string): string {
  const cmds: string[] = [];
  for (const m of input.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      cmds.push(`$ ${JSON.parse(m[1] as string)}`);
    } catch {}
  }
  return cmds.length ? cmds.join("\n") : input;
}

/** Tool output as text: content-part arrays are joined, `exec_command` results unwrapped. */
export function codexOutputText(o: unknown): string {
  if (typeof o === "object" && o && !Array.isArray(o) && "content" in o) {
    return codexOutputText((o as { content: unknown }).content);
  }
  if (!Array.isArray(o)) return str(o);
  return o
    .map((part: { text?: unknown }) => {
      const text = typeof part?.text === "string" ? part.text : str(part);
      try {
        type Result = { output?: unknown; exit_code?: unknown };
        const v = JSON.parse(text) as Result & { value?: Result };
        const r = v?.value ?? v;
        if (typeof r?.output === "string") {
          const code = r.exit_code;
          return code === 0 || code === undefined ? r.output : `[exit ${code}]\n${r.output}`;
        }
      } catch {}
      return text;
    })
    .join("\n");
}

export function projectTranscript(
  trajectory: AtifTrajectory,
  file: string | null = null,
): SessionTranscript {
  const messages: SessionMessage[] = [];
  const text = (content: string | AtifContentPart[] | null | undefined): string =>
    typeof content === "string"
      ? content
      : (content ?? [])
          .map((p) => (p.type === "text" ? p.text : `[${p.type}: ${p.source?.path}]`))
          .join("\n");
  let stepId: number | undefined;
  const push = (message: SessionMessage) => {
    const limit = message.kind.startsWith("tool_") ? 4000 : 8000;
    message = { ...message, stepId };
    messages.push(
      message.text.length > limit
        ? { ...message, text: message.text.slice(0, limit), truncated: true }
        : message,
    );
  };
  for (const step of trajectory.steps) {
    stepId = step.step_id;
    const at = step.timestamp ?? null;
    const role = step.source === "agent" ? "assistant" : step.source;
    const message = text(step.message);
    if (message) push({ at, role, kind: "text", text: message });
    if (step.reasoning_content)
      push({ at, role: "assistant", kind: "thinking", text: step.reasoning_content });
    for (const call of step.tool_calls ?? []) {
      const custom = call.extra?.orbit as { native_type?: string } | undefined;
      push({
        at,
        role: "assistant",
        kind: "tool_call",
        name: call.function_name,
        text:
          custom?.native_type === "custom_tool_call" && typeof call.arguments.input === "string"
            ? codexCallText(call.arguments.input)
            : str(call.arguments),
      });
    }
    for (const result of step.observation?.results ?? []) {
      const call = step.tool_calls?.find((c) => c.tool_call_id === result.source_call_id);
      const native = result.extra?.orbit as { timestamp?: string } | undefined;
      push({
        at: native?.timestamp ?? at,
        role: call ? "tool" : "system",
        kind: call ? "tool_result" : "text",
        ...(call ? { name: call.function_name } : {}),
        text: text(result.content),
      });
    }
  }
  return {
    harness: trajectory.agent.name,
    sessionId: trajectory.session_id ?? trajectory.trajectory_id ?? "unknown",
    file,
    completeness: trajectory.extra?.orbit?.completeness,
    messages: messages.slice(-5000),
  };
}
