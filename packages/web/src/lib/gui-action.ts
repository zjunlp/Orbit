import type { GuiTrace, SessionMessage } from "@zjunlp/orbit/contracts";

export interface ActionOverlay {
  point?: [number, number];
  end?: [number, number];
  text?: string;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const STR = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const REST = String.raw`\s*(?:,[^()]*)?`;
// BrowserGym's coordinate action set (browsergym.core.action.functions).
const POINT = new RegExp(
  String.raw`^\s*(?:mouse_click|mouse_dblclick|mouse_move|mouse_down|mouse_up)\(\s*${NUM}\s*,\s*${NUM}${REST}\)\s*$`,
);
const DRAG = new RegExp(
  String.raw`^\s*mouse_drag_and_drop\(\s*${NUM}\s*,\s*${NUM}\s*,\s*${NUM}\s*,\s*${NUM}\s*\)\s*$`,
);
const TYPE = new RegExp(String.raw`^\s*keyboard_type\(\s*(?:text\s*=\s*)?${STR}\s*\)\s*$`);
const FILL = new RegExp(
  String.raw`^\s*fill\(\s*(?:bid\s*=\s*)?${STR}\s*,\s*(?:value\s*=\s*)?${STR}${REST}\)\s*$`,
);

/** The text of a Python string literal, for display only. */
function literal(quoted: string): string {
  return quoted.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
}

/** Read a small display-only subset of original BrowserGym calls; never evaluate Python. */
export function actionOverlay(action: string | null): ActionOverlay {
  if (!action || action.length > 20_000) return {};
  const point = POINT.exec(action);
  if (point) return { point: [Number(point[1]), Number(point[2])] };
  const drag = DRAG.exec(action);
  if (drag)
    return {
      point: [Number(drag[1]), Number(drag[2])],
      end: [Number(drag[3]), Number(drag[4])],
    };
  const typed = TYPE.exec(action);
  if (typed?.[1]) return { text: literal(typed[1]).slice(0, 2000) };
  const filled = FILL.exec(action);
  if (filled?.[2]) return { text: literal(filled[2]).slice(0, 2000) };
  return {};
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
