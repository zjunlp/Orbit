import type {
  AuthProfile,
  BenchCapabilities,
  BenchJob,
  BenchJobSpecInput,
  Benchmark,
  BenchTask,
  Method,
} from "@zjunlp/orbit/contracts";
import { stableValue } from "./conditions.ts";

/** Method kinds that are not Agent CLIs. */
export const SPECIAL_TYPES = ["empty", "external", "oracle"] as const;
const RESERVED = [...SPECIAL_TYPES, "policy"];

/** Default list before the daemon's Agent registry has loaded. */
export const METHOD_TYPES: Method["agent"][] = [
  "empty",
  "external",
  "codex",
  "claude-code",
  "oracle",
];

/** Method types for a registry: the special kinds around every registered Agent name. */
export function methodTypes(agents: string[]): Method["agent"][] {
  return ["empty", "external", ...agents.filter((a) => !RESERVED.includes(a)), "oracle"];
}

/** Whether a method runs an Agent CLI (any name that is not a reserved kind). */
export function isCliAgent(agent: string): boolean {
  return !RESERVED.includes(agent);
}

/** Same rule as the daemon: concrete names keep their meaning; `cli` admits every Agent CLI. */
export function capabilityAllows(methods: readonly string[], agent: string): boolean {
  return methods.includes(agent) || (methods.includes("cli") && isCliAgent(agent));
}

export interface MethodDraft {
  id: string;
  name: string;
  agent: Method["agent"];
  model: string;
  auth: string;
  entrypoint: string;
  config: string;
  passEnv: string;
  effort: string;
  bundle: string;
}

let draftSequence = 0;

export function methodDraft(method: Method): MethodDraft {
  return {
    id: `method-draft-${++draftSequence}`,
    name: method.name,
    agent: method.agent,
    model: method.model ?? "",
    auth: method.auth ?? "",
    entrypoint: method.entrypoint ?? "",
    config: JSON.stringify(method.config ?? {}, null, 2),
    passEnv: method.passEnv?.join(", ") ?? "",
    effort: method.effort ?? "",
    bundle: method.bundle ?? "",
  };
}

const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function stringMap(text: string, label: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() || "{}");
  } catch {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (!isObject(value) || Object.values(value).some((v) => typeof v !== "string"))
    throw new Error(`${label} must be an object with string values.`);
  return value as Record<string, string>;
}

export function buildMethods(
  drafts: MethodDraft[],
  capabilities?: BenchCapabilities,
  profiles?: AuthProfile[],
): Method[] {
  if (!drafts.length) throw new Error("Add at least one method.");
  const names = new Set<string>();
  return drafts.map((d) => {
    const name = d.name.trim();
    if (!profileName.test(name))
      throw new Error(
        "Method names need 1–64 letters, digits, '.', '_' or '-', starting with a letter or digit.",
      );
    if (names.has(name)) throw new Error(`Duplicate method name: ${name}.`);
    names.add(name);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(d.agent) || d.agent === "policy")
      throw new Error(`${name}: unknown method type.`);
    if (capabilities && !capabilityAllows(capabilities.methods, d.agent))
      throw new Error(`${name}: ${d.agent} is not supported by this environment.`);
    const m: Method = { name, agent: d.agent };
    const cli = isCliAgent(d.agent);
    if (cli) {
      if (!d.auth || !profileName.test(d.auth)) throw new Error(`${name}: select an auth profile.`);
      if (profiles && !profiles.some((p) => p.name === d.auth && p.harness === d.agent))
        throw new Error(`${name}: select an auth profile for ${d.agent}.`);
      m.auth = d.auth;
      if (d.bundle.trim()) m.bundle = d.bundle.trim();
    }
    if (cli || d.agent === "external") {
      if (d.model.trim()) m.model = d.model.trim();
      if (d.effort.trim()) {
        if (!/^[A-Za-z0-9_-]+$/.test(d.effort.trim()))
          throw new Error(`${name}: effort must be a plain word.`);
        m.effort = d.effort.trim();
      }
    }
    if (d.agent === "external") {
      if (!d.entrypoint.trim()) throw new Error(`${name}: enter the installed policy entrypoint.`);
      m.entrypoint = d.entrypoint.trim();
      m.config = stringMap(d.config, `${name} configuration`);
      const passEnv = [...new Set(d.passEnv.split(/[\s,]+/).filter(Boolean))];
      if (passEnv.some((key) => !envName.test(key)))
        throw new Error(
          `${name}: use environment variable names, not values, in Pass-through variables.`,
        );
      if (passEnv.length) m.passEnv = passEnv;
    }
    return m;
  });
}

export function importMethods(text: string): MethodDraft[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Methods must be a JSON array.");
  }
  if (!Array.isArray(value) || !value.length) throw new Error("Import a non-empty methods array.");
  const keys = [
    "name",
    "agent",
    "model",
    "auth",
    "entrypoint",
    "config",
    "passEnv",
    "effort",
    "bundle",
  ];
  const drafts = value.map((v) => {
    if (!isObject(v) || Object.keys(v).some((k) => !keys.includes(k)))
      throw new Error("Each method must contain only supported method fields.");
    for (const key of ["name", "agent"]) {
      if (typeof v[key] !== "string") throw new Error(`Every method needs a ${key}.`);
    }
    for (const key of ["model", "auth", "entrypoint", "effort", "bundle"]) {
      if (v[key] !== undefined && typeof v[key] !== "string")
        throw new Error(`Method ${key} must be text.`);
    }
    if (
      v.config !== undefined &&
      (!isObject(v.config) || Object.values(v.config).some((x) => typeof x !== "string"))
    )
      throw new Error("Method config must contain string values.");
    if (
      v.passEnv !== undefined &&
      (!Array.isArray(v.passEnv) || v.passEnv.some((x) => typeof x !== "string"))
    )
      throw new Error("Method passEnv must be an array of variable names.");
    if (v.agent === "external" && (v.auth || v.bundle))
      throw new Error("External policies use passEnv, not CLI auth profiles or bundles.");
    if (
      v.agent !== "external" &&
      (v.entrypoint !== undefined || v.config !== undefined || v.passEnv !== undefined)
    )
      throw new Error("entrypoint, config and passEnv are only supported for external policies.");
    if (
      (v.agent === "empty" || v.agent === "oracle") &&
      (v.model || v.auth || v.bundle || v.effort)
    )
      throw new Error("Empty and oracle methods do not take model or auth settings.");
    return methodDraft(v as Method);
  });
  buildMethods(drafts);
  return drafts;
}

export interface EvaluationFields {
  benchmark: string;
  tasks: string[];
  name: string;
  seeds: string;
  timeout: string;
  options: string;
}

export function evaluationSpec(
  fields: EvaluationFields,
  methods: Method[],
  tasks: BenchTask[],
  source?: BenchJob,
): BenchJobSpecInput {
  if (!fields.benchmark) throw new Error("Select a registered environment.");
  const selected = [...new Set(fields.tasks)];
  if (!selected.length) throw new Error("Select at least one supported task.");
  const supported = new Set(tasks.filter((t) => t.supported).map((t) => t.id));
  if (selected.some((id) => !supported.has(id)))
    throw new Error("Some selected tasks are missing or unsupported. Review the task selection.");
  const seeds = Number(fields.seeds);
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 100)
    throw new Error("Repetitions must be a whole number between 1 and 100.");
  const timeout = fields.timeout.trim() ? Number(fields.timeout) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
    throw new Error("Timeout must be a positive number of minutes, or blank for the preset.");
  if (fields.name.length > 200) throw new Error("Evaluation name must be at most 200 characters.");
  if (!methods.length) throw new Error("Add at least one method.");
  return {
    benchmark: fields.benchmark,
    tasks: selected,
    methods,
    seeds,
    options: stringMap(fields.options, "Evaluation options"),
    ...(fields.name.trim() ? { name: fields.name.trim() } : {}),
    ...(timeout !== undefined ? { timeoutMin: timeout } : {}),
    ...(source?.spec.checkpoint ? { checkpoint: source.spec.checkpoint } : {}),
  };
}

export function taskSubset(query: URLSearchParams): string[] | undefined {
  if (query.has("task")) return query.getAll("task").filter(Boolean);
  return query.has("tasks") ? (query.get("tasks") ?? "").split(",").filter(Boolean) : undefined;
}

export function registrationChanged(source: BenchJob, registered: Benchmark): boolean | null {
  const saved = source.benchmarkSnapshot;
  if (!saved) return null;
  return ["adapter", "path", "config", "env", "passEnv", "resources"].some(
    (key) =>
      stableValue(saved[key as keyof Benchmark]) !==
      stableValue(registered[key as keyof Benchmark]),
  );
}

/** Attach explicit lineage to one method under test. */
export function withLineage(
  spec: BenchJobSpecInput,
  l: { parent: string; note: string; informedBy: string; method?: string },
): BenchJobSpecInput {
  const parent = l.parent.trim();
  const note = l.note.trim();
  const informedBy = l.informedBy
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parent && !/^[0-9a-f]{12}$/.test(parent))
    throw new Error("Parent revision must be 12 lowercase hex digits.");
  if (!parent && !note && !informedBy.length) return spec;
  const methods = spec.methods.filter((m) => m.agent !== "oracle" && m.agent !== "empty");
  if (l.method && !methods.some((m) => m.name === l.method))
    throw new Error("Select the method this lineage applies to.");
  if (methods.length > 1 && !l.method) throw new Error("Select one method for this lineage.");
  const lineage = Object.fromEntries(
    methods
      .filter((m) => !l.method || m.name === l.method)
      .map((m) => [
        m.name,
        { ...(parent ? { parent } : {}), ...(note ? { note } : {}), informedBy },
      ]),
  );
  return Object.keys(lineage).length ? { ...spec, lineage } : spec;
}

/** Deriving a trial copies only its method; an ordinary copy retains the whole evaluation. */
export function copiedMethods(source: BenchJob, method: string, parent: string): Method[] {
  if (!method && !parent) return source.spec.methods;
  const candidates = source.spec.methods.filter((m) =>
    method ? m.name === method : source.revisions[m.name]?.revision === parent,
  );
  if (
    candidates.length !== 1 ||
    candidates.some((m) => m.agent === "oracle" || m.agent === "empty")
  )
    throw new Error("Select a single evaluated method to derive.");
  const recorded = source.revisions[candidates[0]?.name ?? ""];
  if (parent && recorded && recorded.revision !== parent)
    throw new Error("The parent revision does not match this method.");
  return candidates;
}
