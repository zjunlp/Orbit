import {
  brief,
  type Conversation,
  callSummary,
  parseResult,
  type ToolCall,
} from "../../lib/conversation.ts";
import { Field, Json } from "./conversation-parts.tsx";

export type Labels = Record<string, Conversation["participants"][number]>;

export function Message({ actor, text, label }: { actor: string; text: string; label: Labels }) {
  const role = label[actor]?.role ?? actor;
  return (
    <div className={`conv-msg role-${role}`}>
      <div className="conv-who">{label[actor]?.label ?? actor}</div>
      <div className="conv-text">{text || <span className="faint">(empty)</span>}</div>
    </div>
  );
}

export function CallCard({
  call,
  label,
  open,
  onToggle,
}: {
  call: ToolCall;
  label: Labels;
  open: boolean;
  onToggle: () => void;
}) {
  const role = label[call.actor]?.role ?? call.actor;
  return (
    <div className={`conv-call st-${call.status} role-${role}`}>
      <button
        type="button"
        className="conv-call-h"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <span className={`conv-actor role-${role}`}>{label[call.actor]?.label ?? call.actor}</span>
        <span className="conv-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="mono conv-call-sig">{callSummary(call)}</span>
        <span className="spacer" />
        {call.status !== "ok" && (
          <span className={`chip ${call.status === "error" ? "bad" : "warn"}`}>{call.status}</span>
        )}
        {call.status === "ok" && call.result !== undefined && (
          <span className="faint mono conv-call-res">→ {brief(call.result, 48)}</span>
        )}
      </button>
      {open && (
        <div className="conv-call-b">
          {call.source && call.source !== callSummary(call, 1e9) && (
            <Field label="As written">
              <pre className="mono">{call.source}</pre>
            </Field>
          )}
          <Field label="Arguments">
            <Json v={call.arguments} />
          </Field>
          {call.error && (
            <Field label={call.status === "rejected" ? "Rejected" : "Error"}>
              <pre className="mono conv-err">{call.error}</pre>
            </Field>
          )}
          {call.result !== undefined && call.status !== "error" && (
            <Field label="Result">
              <Json v={parseResult(call.result)} />
            </Field>
          )}
          <div className="faint mono">call {call.id}</div>
        </div>
      )}
    </div>
  );
}
