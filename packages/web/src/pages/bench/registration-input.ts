import type { BenchmarkInput } from "@zjunlp/orbit/contracts";

export const DEFINITION_LIMIT = 1024 * 1024;
export function parseDefinition(text: string): BenchmarkInput {
  if (new TextEncoder().encode(text).length > DEFINITION_LIMIT)
    throw new Error("Definition JSON must be at most 1 MiB.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Enter valid benchmark JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Definition must be a JSON object.");
  for (const key of ["name", "path", "adapter"])
    if (typeof (value as Record<string, unknown>)[key] !== "string")
      throw new Error(
        `Definition needs a ${key} string. The daemon checks the complete definition.`,
      );
  return value as BenchmarkInput;
}
