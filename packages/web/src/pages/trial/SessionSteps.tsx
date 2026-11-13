import type { SessionMessage } from "@zjunlp/orbit/contracts";

export function SessionSteps({
  stepIds,
  indexes,
  messages,
}: {
  stepIds?: number[];
  indexes?: number[];
  messages: SessionMessage[];
}) {
  const selected =
    stepIds !== undefined
      ? messages.filter((m) => m.stepId !== undefined && stepIds.includes(m.stepId))
      : (indexes ?? []).flatMap((i) => (messages[i] ? [messages[i]] : []));
  return selected.length ? (
    selected.map((message) => (
      <details
        key={`${message.stepId}-${message.kind}-${message.name}-${message.at}-${message.text}`}
        open={message.kind === "thinking"}
      >
        <summary>
          {message.stepId ? `Step ${message.stepId} · ` : ""}
          {message.kind.replace("_", " ")}
          {message.name ? ` · ${message.name}` : ""}
        </summary>
        <pre>{message.text}</pre>
      </details>
    ))
  ) : (
    <p className="faint">
      No session messages linked here. The full Agent session remains available.
    </p>
  );
}
