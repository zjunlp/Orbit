import type { Redactor } from "../../lib/redact.ts";

export class TrajectoryExportError extends Error {}

const PATTERNS = [
  /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]{8,}@/i,
  /\b(?:[A-Za-z0-9]{1,32}[_-]){0,8}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9_+./=-]{8,}/i,
];
const SENSITIVE_KEY =
  /^(?:[A-Za-z0-9]{1,32}[_-]){0,8}(?:(?:api|access|auth|refresh)[_-]?(?:key|token)|password|passwd|client[_-]?secret|private[_-]?key|token|secret)$/i;
const PLACEHOLDER = /^(?:\[redacted\]|\$\{[^}]+\}|<[^>]+>)$/i;

/** Report locations only: error messages must never repeat suspected credential values. */
export function assertNoSecrets(value: unknown, location: string): void {
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (PATTERNS.some((pattern) => pattern.test(v)))
        throw new TrajectoryExportError(`secret pattern at ${path}`);
    } else if (Array.isArray(v))
      v.forEach((item, i) => {
        walk(item, `${path}[${i}]`);
      });
    else if (v && typeof v === "object") {
      for (const [i, [key, item]] of Object.entries(v).entries()) {
        walk(key, `${path}.$key[${i}]`);
        if (
          /^(?:encrypted_content|encrypted_reasoning|thinking_signature|redacted_thinking)$/i.test(
            key,
          ) &&
          item != null
        )
          throw new TrajectoryExportError(`opaque reasoning field at ${path}.$value[${i}]`);
        const next = `${path}.${/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : `$value[${i}]`}`;
        if (
          SENSITIVE_KEY.test(key) &&
          typeof item === "string" &&
          item.length >= 8 &&
          !PLACEHOLDER.test(item)
        )
          throw new TrajectoryExportError(`secret field at ${next}`);
        walk(item, next);
      }
    }
  };
  walk(value, location);
}

export function redactExport(value: unknown, redactor: Redactor): unknown {
  if (typeof value === "string") return redactor.apply(value);
  if (Array.isArray(value)) return value.map((item) => redactExport(item, redactor));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const clean = redactor.apply(key);
      if (Object.hasOwn(result, clean))
        throw new TrajectoryExportError("redaction would merge object keys");
      Object.defineProperty(result, clean, {
        value: redactExport(item, redactor),
        enumerable: true,
      });
    }
    return result;
  }
  return value;
}
