import type {
  AgentDefinition,
  AuthProfile,
  BenchCapabilities,
  BenchCompatibility,
  BenchJob,
  BenchJobSpecInput,
  Benchmark,
  BenchTask,
  CompatibilityCell,
  JobCalibration,
  Method,
  SamplePlan,
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
  policyRef: string;
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
    policyRef: method.policyRef ?? "",
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

export function compatibilityCells(benchmark: string, result?: BenchCompatibility) {
  return result?.checked?.benchmark === benchmark
    ? result.rows.find((row) => row.benchmark === benchmark)?.cells
    : undefined;
}

export function profileAllowed(profile: AuthProfile, agent: string, definition?: AgentDefinition) {
  return profile.harness === agent && (!definition || definition.auth.kinds.includes(profile.kind));
}

export function configurationBlocker(
  draft: MethodDraft,
  profiles?: AuthProfile[],
  definitions?: AgentDefinition[],
  cell?: CompatibilityCell,
): string | null {
  if (!isCliAgent(draft.agent)) return null;
  const definition = definitions?.find((entry) => entry.name === draft.agent);
  if (definitions && !definition) return `Agent ${draft.agent} is not registered.`;
  if (cell?.state === "blocked")
    return cell.reason ?? "This Agent is blocked for the selected environment.";
  if (!draft.auth) return "Select an auth profile.";
  const profile = profiles?.find((entry) => entry.name === draft.auth);
  if (profiles && !profile) return `Auth profile ${draft.auth} is not available.`;
  if (profile && profile.harness !== draft.agent)
    return `Auth profile ${draft.auth} is for ${profile.harness}, not ${draft.agent}.`;
  if (profile && definition && !definition.auth.kinds.includes(profile.kind))
    return `${draft.agent} does not accept ${profile.kind} auth profiles.`;
  return null;
}

export function buildMethods(
  drafts: MethodDraft[],
  capabilities?: BenchCapabilities,
  profiles?: AuthProfile[],
  definitions?: AgentDefinition[],
  cells?: Record<string, CompatibilityCell>,
): Method[] {
  if (!drafts.length) throw new Error("Add at least one configuration.");
  const names = new Set<string>();
  return drafts.map((d) => {
    const name = d.name.trim();
    if (!profileName.test(name))
      throw new Error(
        "Configuration names need 1–64 letters, digits, '.', '_' or '-', starting with a letter or digit.",
      );
    if (names.has(name)) throw new Error(`Duplicate configuration name: ${name}.`);
    names.add(name);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(d.agent))
      throw new Error(`${name}: unknown configuration type.`);
    if (capabilities && !capabilityAllows(capabilities.methods, d.agent))
      throw new Error(`${name}: ${d.agent} is not supported by this environment.`);
    const m: Method = { name, agent: d.agent };
    if (d.agent === "policy") {
      const policyRef = d.policyRef.trim();
      if (!profileName.test(policyRef)) throw new Error(`${name}: select a registered policy.`);
      return { ...m, policyRef };
    }
    const cli = isCliAgent(d.agent);
    if (cli) {
      const blocker = configurationBlocker(d, profiles, definitions, cells?.[d.agent]);
      if (blocker) throw new Error(`${name}: ${blocker}`);
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
    throw new Error("Configurations must be a JSON array.");
  }
  if (!Array.isArray(value) || !value.length)
    throw new Error("Import a non-empty configurations array.");
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
      throw new Error("Each configuration must contain only supported fields.");
    for (const key of ["name", "agent"]) {
      if (typeof v[key] !== "string") throw new Error(`Every configuration needs a ${key}.`);
    }
    if (v.agent === "policy")
      throw new Error("Choose registered policies in the frozen sample plan workflow.");
    for (const key of ["model", "auth", "entrypoint", "effort", "bundle"]) {
      if (v[key] !== undefined && typeof v[key] !== "string")
        throw new Error(`Configuration ${key} must be text.`);
    }
    if (
      v.config !== undefined &&
      (!isObject(v.config) || Object.values(v.config).some((x) => typeof x !== "string"))
    )
      throw new Error("Configuration settings must contain string values.");
    if (
      v.passEnv !== undefined &&
      (!Array.isArray(v.passEnv) || v.passEnv.some((x) => typeof x !== "string"))
    )
      throw new Error("Configuration passEnv must be an array of variable names.");
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
      throw new Error("Empty and oracle configurations do not take model or auth settings.");
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
  samplePlan?: SamplePlan;
  batchSize?: string;
  maxBatchSize?: number;
  calibration?: JobCalibration;
}

export function parseSamplePlan(text: string): SamplePlan {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The frozen sample plan must be valid JSON.");
  }
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.digest !== "string" ||
    !Array.isArray(value.items) ||
    !value.items.length ||
    value.items.some((item) => !isObject(item) || typeof item.taskId !== "string" || !item.taskId)
  )
    throw new Error("Choose a version 1 frozen sample plan with a digest and at least one sample.");
  // The daemon validates the complete plan and its digest on submission.
  return value as unknown as SamplePlan;
}

export function samplePlanTasks(plan: SamplePlan): string[] {
  return [...new Set(plan.items.map(({ taskId }) => taskId))];
}

export function evaluationTasks(
  fields: Pick<EvaluationFields, "benchmark" | "tasks" | "samplePlan" | "calibration">,
  tasks: BenchTask[],
): string[] {
  if (!fields.benchmark) throw new Error("Select a registered environment.");
  const { samplePlan, calibration } = fields;
  if (calibration?.mode === "policy") {
    if (!samplePlan) throw new Error("Policy calibration needs a frozen sample plan.");
    const sampleCount = samplePlan.items.length;
    if (sampleCount < 2 || sampleCount > 5)
      throw new Error("Policy calibration needs 2–5 samples.");
  }
  const selected = samplePlan ? samplePlanTasks(samplePlan) : [...new Set(fields.tasks)];
  if (!selected.length) throw new Error("Select at least one supported task.");
  const supported = new Set(tasks.filter((t) => t.supported).map((t) => t.id));
  const unsupported = selected.find((id) => !supported.has(id));
  if (unsupported !== undefined) {
    if (samplePlan)
      throw new Error(
        `The sample plan task ${unsupported} is missing or unsupported in this environment.`,
      );
    throw new Error("Some selected tasks are missing or unsupported. Review the task selection.");
  }
  return selected;
}

export class BatchSizeError extends Error {}

/** Undefined uses the environment preset; null means the input is invalid. */
export function evaluationTimeoutMin(
  value: string,
  calibrationBudget?: number,
): number | undefined | null {
  const minutes = value.trim() ? Number(value) : undefined;
  if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) return null;
  return calibrationBudget === undefined
    ? minutes
    : Math.min(minutes ?? calibrationBudget, calibrationBudget);
}

export function evaluationSpec(
  fields: EvaluationFields,
  methods: Method[],
  tasks: BenchTask[],
  source?: BenchJob,
): BenchJobSpecInput {
  const selected = evaluationTasks(fields, tasks);
  const samplePlan = fields.samplePlan;
  const calibration = fields.calibration?.mode === "policy" ? fields.calibration : undefined;
  const timeoutMin = evaluationTimeoutMin(fields.timeout, calibration?.budgetMin);
  if (timeoutMin === null)
    throw new Error("Timeout must be a positive number of minutes, or blank for the preset.");
  if (fields.name.length > 200) throw new Error("Evaluation name must be at most 200 characters.");
  if (!methods.length) throw new Error("Add at least one configuration.");
  const spec = {
    benchmark: fields.benchmark,
    tasks: selected,
    methods,
    options: stringMap(fields.options, "Evaluation options"),
    ...(fields.name.trim() ? { name: fields.name.trim() } : {}),
    ...(timeoutMin !== undefined ? { timeoutMin } : {}),
    ...(source?.spec.checkpoint ? { checkpoint: source.spec.checkpoint } : {}),
  };
  if (samplePlan) {
    if (methods.some((method) => method.agent !== "policy"))
      throw new Error("Frozen sample plans require registered policy configurations.");
    if (calibration) {
      if (methods.length !== 1)
        throw new Error("Policy calibration needs exactly one registered policy.");
      if (calibration.budgetMin === undefined)
        throw new Error("The copied policy calibration has no total budget.");
      return {
        ...spec,
        samplePlan,
        batchSize: samplePlan.items.length,
        calibration,
      };
    }
    const batchSize = fields.batchSize?.trim() ? Number(fields.batchSize) : undefined;
    const maxBatchSize = fields.maxBatchSize ?? 256;
    if (
      batchSize !== undefined &&
      (!Number.isInteger(batchSize) || batchSize < 2 || batchSize > maxBatchSize)
    )
      throw new BatchSizeError(
        `Batch size must be a whole number from 2 to ${maxBatchSize}. Leave it blank to run one sample per solve.`,
      );
    return { ...spec, samplePlan, ...(batchSize === undefined ? {} : { batchSize }) };
  }
  if (methods.some((method) => method.agent === "policy"))
    throw new Error("Upload a frozen sample plan to evaluate a registered policy.");
  const seeds = Number(fields.seeds);
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 100)
    throw new Error("Repetitions must be a whole number between 1 and 100.");
  return { ...spec, seeds };
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
    throw new Error("Source version must be 12 lowercase hex digits.");
  if (!parent && !note && !informedBy.length) return spec;
  const methods = spec.methods.filter((m) => m.agent !== "oracle" && m.agent !== "empty");
  if (l.method && !methods.some((m) => m.name === l.method))
    throw new Error("Select the configuration these notes apply to.");
  if (methods.length > 1 && !l.method) throw new Error("Select one configuration for these notes.");
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
    throw new Error("Select a single evaluated configuration to adjust.");
  const recorded = source.revisions[candidates[0]?.name ?? ""];
  if (parent && recorded && recorded.revision !== parent)
    throw new Error("The source version does not match this configuration.");
  return candidates;
}
