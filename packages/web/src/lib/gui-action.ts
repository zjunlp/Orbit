import type { GuiTrace, SessionMessage } from "@zjunlp/orbit/contracts";

export interface ActionOverlay {
  point?: [number, number];
  end?: [number, number];
  text?: string;
}

/** Read a small display-only subset of original BrowserGym calls; never evaluate Python. */
export function actionOverlay(action: string | null): ActionOverlay {
  if (!action || action.length > 20_000) return {};
  const match =
    /^\s*(mouse_click|mouse_dblclick|mouse_move|mouse_drag)\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?))?\s*\)\s*$/.exec(
      action,
    );
  if (match) {
    const point: [number, number] = [Number(match[2]), Number(match[3])];
    if (match[1] === "mouse_drag" && match[4] !== undefined && match[5] !== undefined)
      return { point, end: [Number(match[4]), Number(match[5])] };
    if (match[1] !== "mouse_drag" && match[4] === undefined) return { point };
  }
  const text = /^\s*(?:keyboard_type|fill)\((.*)\)\s*$/.exec(action);
  return text ? { text: text[1]?.slice(0, 2000) } : {};
}

export function stepMessages(trace: GuiTrace, index: number, messages: SessionMessage[]) {
  const id = trace.steps[index]?.actionId;
  if (!id) return [];
  // Match the returned operation id, not a guessed clock alignment or a repeated action string.
  const result = messages.findIndex(
    (message) => message.kind === "tool_result" && resultHasId(message.text, id, index),
  );
  if (result < 0) return [];
  let start = result;
  while (
    start > 0 &&
    messages[start - 1]?.kind !== "tool_result" &&
    messages[start - 1]?.role !== "user"
  )
    start--;
  return messages
    .slice(Math.max(0, start), result + 1)
    .filter((message) => ["thinking", "tool_call", "tool_result"].includes(message.kind));
}

function resultHasId(text: string, id: string, step: number, depth = 0): boolean {
  if (depth > 3) return false;
  const values = [text, ...text.split("\n")];
  for (const candidate of values) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const object = value as Record<string, unknown>;
      if (object.id === id && object.step === step) return true;
      if (
        Array.isArray(object.content) &&
        object.content.some((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          const block = item as Record<string, unknown>;
          return (
            block.type === "text" &&
            typeof block.text === "string" &&
            resultHasId(block.text, id, step, depth + 1)
          );
        })
      )
        return true;
    } catch {
      /* Agent CLI transcript wrappers may prefix JSON output with status lines. */
    }
  }
  return false;
}
