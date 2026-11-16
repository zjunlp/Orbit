import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { GateBundleCheck, GateBundleInput, parseTaskFile } from "../contracts/index.ts";
import { inspectBundle } from "../lib/bundle.ts";
import { hasSecretPattern, isSecretField } from "../lib/redact.ts";
import { UserError } from "../runs/service.ts";
import { validateGateTasks } from "./gates.ts";

function jsonHasSecrets(text: string): boolean {
  if (!/^\s*[[{]/.test(text)) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const pending = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 1000000) throw new Error("method bundle JSON exceeds one million values");
    const next = pending.pop();
    if (typeof next === "string" && hasSecretPattern(next)) return true;
    if (Array.isArray(next)) for (const item of next) pending.push(item);
    else if (next && typeof next === "object")
      for (const [key, item] of Object.entries(next)) {
        if (isSecretField(key, item) || hasSecretPattern(key)) return true;
        pending.push(item);
      }
  }
  return false;
}

/** A bounded literal matcher: task IDs are data, never regular expressions. */
function matcher(words: string[]) {
  const nodes: { next: Map<string, number>; fail: number; hit: boolean }[] = [
    { next: new Map(), fail: 0, hit: false },
  ];
  for (const word of words) {
    let at = 0;
    for (const letter of word) {
      const node = nodes[at];
      if (!node) throw new Error("invalid literal matcher");
      let next = node.next.get(letter);
      if (next === undefined) {
        if (nodes.length >= 1000000) throw new Error("task ID matcher exceeds one million nodes");
        next = nodes.length;
        node.next.set(letter, next);
        nodes.push({ next: new Map(), fail: 0, hit: false });
      }
      at = next;
    }
    const node = nodes[at];
    if (node) node.hit = true;
  }
  const queue = [...(nodes[0]?.next.values() ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    const node = at === undefined ? undefined : nodes[at];
    if (!node) continue;
    for (const [letter, index] of node.next) {
      let fallback = node.fail;
      while (fallback && !nodes[fallback]?.next.has(letter)) fallback = nodes[fallback]?.fail ?? 0;
      const child = nodes[index];
      if (!child) continue;
      child.fail = nodes[fallback]?.next.get(letter) ?? 0;
      child.hit ||= nodes[child.fail]?.hit ?? false;
      queue.push(index);
    }
  }
  return (text: string) => {
    let at = 0;
    for (const letter of text) {
      while (at && !nodes[at]?.next.has(letter)) at = nodes[at]?.fail ?? 0;
      at = nodes[at]?.next.get(letter) ?? 0;
      if (nodes[at]?.hit) return true;
    }
    return false;
  };
}

export function checkGateBundle(input: unknown): GateBundleCheck {
  const { directory, policy, taskSets } = GateBundleInput.parse(input);
  if (!isAbsolute(directory))
    throw new UserError("bundle directory must be an absolute daemon-local path");
  validateGateTasks(policy, taskSets);
  const findings: GateBundleCheck["findings"] = [];
  const counts = new Map<string, number>();
  let truncated = false,
    files = 0,
    bytes = 0,
    complete = false;
  let digest: string | null = null;
  const add = (
    kind: GateBundleCheck["findings"][number]["kind"],
    file: string | null,
    detail: string,
  ) => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (findings.length < 100)
      findings.push({
        kind,
        file: file && hasSecretPattern(file) ? "[redacted path]" : file,
        detail,
      });
    else truncated = true;
  };
  const references = new Set(policy.bundle?.reference_sha256 ?? []);
  try {
    const tasks = matcher([...new Set(taskSets.flatMap((s) => parseTaskFile(s.content)))]);
    const result = inspectBundle(
      directory,
      (file, data) => {
        files++;
        bytes += data.length;
        const text = data.toString("utf8");
        if (hasSecretPattern(file) || hasSecretPattern(text) || jsonHasSecrets(text))
          add("secrets", file, "Suspected credential pattern; value omitted.");
        if (tasks(file) || tasks(text))
          add("task-ids", file, "Contains a literal held-out task ID.");
        if (
          references.has(createHash("sha256").update(data).digest("hex")) ||
          [file, text].some((v) =>
            [...v.matchAll(/[a-fA-F0-9]{64}/g)].some((m) => references.has(m[0].toLowerCase())),
          )
        )
          add(
            "reference-hashes",
            file,
            "Matches a declared reference file SHA-256 or contains its digest.",
          );
      },
      { maxFiles: policy.bundle?.max_files, maxBytes: policy.bundle?.max_bytes, confined: true },
    );
    digest = result.digest;
    complete = true;
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith("method bundle")
        ? error.message
        : "Bundle could not be completely inspected; fix unreadable inputs or reduce task-ID matcher size.";
    add("limits", null, message);
  }
  return GateBundleCheck.parse({
    passed: complete && !findings.length,
    complete,
    digest,
    files,
    bytes,
    findings,
    truncated,
    checks: (["limits", "secrets", "task-ids", "reference-hashes"] as const).map((kind) => ({
      kind,
      result: counts.has(kind)
        ? "failed"
        : !complete || (kind === "reference-hashes" && !references.size)
          ? "not_run"
          : "passed",
      detail:
        kind === "reference-hashes" && !references.size
          ? "No reference SHA-256 values declared; unknown answer files cannot be checked."
          : !complete
            ? "Inspection incomplete; no clean-bundle claim is made."
            : kind === "task-ids"
              ? "Literal IDs from gate, guard and final task files; substring matches may need review."
              : kind === "secrets"
                ? "Known credential patterns only; absence is not proof of no secrets."
                : kind === "limits"
                  ? "Regular files within the bundle, bounded by policy and hard limits."
                  : "Declared reference SHA-256 values checked.",
    })),
  });
}
