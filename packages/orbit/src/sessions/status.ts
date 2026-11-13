import { parseNativeJsonl } from "./atif.ts";

const errorText = (v: unknown): string => {
  const m = (v as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : typeof v === "string" ? v : JSON.stringify(v ?? "");
};

/** Only CLI-owned response events count; user text and tool output never prove model access. */
function codexModelResponse(e: Record<string, unknown>): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (e.type === "response_item") {
    if (p.type === "function_call" || p.type === "custom_tool_call")
      return typeof p.name === "string" && p.name.length > 0;
    if (p.type === "reasoning")
      return (
        (typeof p.encrypted_content === "string" && p.encrypted_content.length > 0) ||
        (Array.isArray(p.summary) && p.summary.some((part) => Boolean(part?.text)))
      );
    return (
      p.type === "message" &&
      p.role === "assistant" &&
      Array.isArray(p.content) &&
      p.content.some((part) => typeof part?.text === "string" && part.text.length > 0)
    );
  }
  if (e.type !== "event_msg") return false;
  if (p.type === "agent_message") return typeof p.message === "string" && p.message.length > 0;
  if (p.type === "agent_reasoning") return typeof p.text === "string" && p.text.length > 0;
  return (
    p.type === "task_complete" &&
    !p.error &&
    typeof p.last_agent_message === "string" &&
    p.last_agent_message.length > 0
  );
}

function claudeModelResponse(e: Record<string, unknown>): boolean {
  if (e.type !== "assistant" || e.isApiErrorMessage === true || e.isSidechain === true)
    return false;
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.length > 0;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        (part.type === "text" && Boolean(part.text)) ||
        (part.type === "thinking" && Boolean(part.thinking)) ||
        (part.type === "tool_use" && Boolean(part.name)),
    )
  );
}

export function nativeStatus(input: string, harness: "codex" | "claude-code") {
  const events = parseNativeJsonl(input).events.map((event) => event.value);
  let text: string | null = null;
  let code: unknown;
  let responded = false;
  let open = false;
  if (harness === "codex") {
    for (const e of events) {
      responded ||= codexModelResponse(e);
      const p = e.payload as { type?: unknown; error?: unknown } | undefined;
      if (e.type !== "event_msg") continue;
      if (p?.type === "task_started") {
        open = true;
        text = null;
        code = undefined;
      } else if (p?.type === "task_complete") {
        open = false;
        text = p.error ? errorText(p.error) : null;
        code = (p.error as { codex_error_info?: unknown } | null)?.codex_error_info;
      }
    }
  } else {
    for (const e of events) {
      if (e.isSidechain === true) continue;
      if (e.type === "system" && e.subtype === "api_error") {
        const error = e.error as
          | { message?: unknown; formatted?: unknown; status?: unknown }
          | undefined;
        text =
          typeof error?.message === "string"
            ? error.message
            : typeof error?.formatted === "string"
              ? error.formatted
              : "API error";
        code = error?.status === 401 || error?.status === 403 ? "authentication_error" : e.error;
        continue;
      }
      if (e.type !== "assistant") continue;
      responded ||= claudeModelResponse(e);
      const content = (e.message as { content?: unknown } | undefined)?.content;
      const message =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
            : "API error";
      text = e.isApiErrorMessage === true ? message : null;
      code = e.isApiErrorMessage === true ? e.error : undefined;
    }
  }
  return { responded, open, text, code };
}
