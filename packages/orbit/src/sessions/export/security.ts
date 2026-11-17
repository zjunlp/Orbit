import { hasSecretPattern, isSecretField, REDACTED, type Redactor } from "../../lib/redact.ts";

export class TrajectoryExportError extends Error {}

/** Report locations only: error messages must never repeat suspected credential values. */
export function assertNoSecrets(value: unknown, location: string): void {
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (hasSecretPattern(v)) throw new TrajectoryExportError(`secret pattern at ${path}`);
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
        if (isSecretField(key, item)) throw new TrajectoryExportError(`secret field at ${next}`);
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

/** Explicitly omit complete affected text values; final scanning still decides exportability. */
export function omitSensitiveText(value: unknown, location: string, omitted: string[]): unknown {
  if (typeof value === "string") {
    if (!hasSecretPattern(value)) return value;
    omitted.push(location);
    return REDACTED;
  }
  if (Array.isArray(value))
    return value.map((v, i) => omitSensitiveText(v, `${location}[${i}]`, omitted));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [i, [key, item]] of Object.entries(value).entries()) {
      const field =
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && !hasSecretPattern(key) ? key : `$value[${i}]`;
      const path = `${location}.${field}`;
      if (isSecretField(key, item)) omitted.push(path);
      Object.defineProperty(result, key, {
        value: isSecretField(key, item) ? REDACTED : omitSensitiveText(item, path, omitted),
        enumerable: true,
      });
    }
    return result;
  }
  return value;
}
