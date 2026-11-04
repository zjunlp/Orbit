import { z } from "zod";
import { AuthKind, EnvName } from "./common.ts";

/**
 * An Agent an experiment can drive. Built-ins (codex, claude-code) have code behind them; other
 * definitions are data, stored per node, and need no rebuild to add or change.
 *
 * Names are also auth profile harnesses, bench method agents and session harnesses, so they must be
 * stable identifiers rather than display labels.
 */
export const AgentName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "use lowercase letters, digits, '.', '_' or '-'");

/** Names that always exist; user definitions cannot replace them. */
export const BUILTIN_AGENTS = ["codex", "claude-code"] as const;
export type BuiltinAgent = (typeof BUILTIN_AGENTS)[number];

/**
 * How the CLI gets into a run's container.
 *
 * `host` mounts what the daemon's machine already has (a static binary, or a global install with
 * `withNode` for CLIs that are Node scripts); `install` runs a script inside the container, which
 * needs network and the toolchain in the image; `image` expects the task image to provide it.
 */
export const AgentInstall = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("host"),
    /** Binary name on the daemon's PATH, or an absolute path. */
    binary: z.string().min(1),
    /** Container directory the host install is mounted at, read-only. */
    mount: z
      .string()
      .startsWith("/", "mount must be an absolute container path")
      .refine((p) => !p.split("/").includes(".."), "mount must not contain `..`"),
    /** Container directories added to PATH (default: the mount itself). */
    pathDirs: z.array(z.string().startsWith("/")).optional(),
    /** Daemon variable overriding the binary path. */
    pathEnv: EnvName.optional(),
    /**
     * Also mount the daemon's Node runtime: a CLI that is a `#!/usr/bin/env node` script cannot run
     * from the image alone when the image ships no Node.
     */
    withNode: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("install"),
    /** Shell command run in the container before the Agent; it must leave `binary` on PATH. */
    script: z.string().min(1),
    binary: z.string().min(1),
  }),
  z.object({
    kind: z.literal("image"),
    binary: z.string().min(1),
    /** Directories to put on PATH when the image keeps the CLI outside it. */
    pathDirs: z.array(z.string().startsWith("/")).default([]),
  }),
]);
export type AgentInstall = z.infer<typeof AgentInstall>;

/**
 * Credentials for one Agent. Orbit never stores the secret here: an auth profile holds it and this
 * says where the CLI expects it. `env` values may use `{model}` and `{baseUrl}`.
 */
export const AgentAuth = z.object({
  kinds: z.array(AuthKind).default(["api-key"]),
  /** Secret variable per kind (never logged). */
  secretEnv: z.partialRecord(AuthKind, EnvName).default({}),
  /** Non-secret variables set for every kind; `{model}`, `{baseUrl}` and `{home}` are filled in. */
  env: z.record(EnvName, z.string()).default({}),
  /** Variable that points the CLI at a custom endpoint (relay profiles). */
  baseUrlEnv: EnvName.optional(),
  /** Variable that selects the model when the CLI reads it from the environment. */
  modelEnv: EnvName.optional(),
  /** Container directory for the CLI's own state, below /orbit/agent. */
  home: z.string().startsWith("/").optional(),
  /** Variable that points the CLI at `home`. */
  homeEnv: EnvName.optional(),
});
export type AgentAuth = z.infer<typeof AgentAuth>;

/** Placeholders a template may use; unknown placeholders are a definition error. */
export const TEMPLATE_PLACEHOLDERS = [
  "{instruction}",
  "{model}",
  "{effort}",
  "{session}",
  "{home}",
] as const;

/**
 * argv for one instruction, and its continuation. Orbit starts the CLI directly (no shell), so the
 * template is a list, not a string.
 */
export const AgentCommand = z.object({
  run: z.array(z.string()).min(1),
  /** How Orbit connects declared stdio tools to this CLI. */
  mcp: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("claude-json"), flag: z.string().min(1) }),
      z.object({ kind: z.literal("codex-toml") }),
      z.object({ kind: z.literal("none") }),
    ])
    .default({ kind: "none" }),
  /** Continuation of a session; `{session}` is the id the CLI reported. */
  resume: z.array(z.string()).optional(),
  /**
   * The CLI's transcript inside the container: a glob below `{home}`, and the parser Orbit uses to
   * show steps and to detect a failed model call. `none` keeps logs only.
   */
  transcript: z
    .object({
      glob: z.string().min(1),
      format: z.enum(["codex", "claude-code", "jsonl", "none"]).default("none"),
    })
    .optional(),
});
export type AgentCommand = z.infer<typeof AgentCommand>;

/** What an Agent can do, checked against a benchmark's requirements before a trial is submitted. */
export const AgentCapabilities = z.object({
  /** One instruction, run to completion. */
  oneShot: z.boolean().default(true),
  /** Can continue the same conversation across turns. */
  multiTurn: z.boolean().default(false),
  /** Can be given MCP servers or extra tools. */
  mcp: z.boolean().default(false),
  /** Can drive a GUI environment through the Orbit tool bridge. */
  gui: z.boolean().default(false),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilities>;

/** A registered Agent. `builtin` definitions come with Orbit and cannot be changed. */
export const AgentDefinition = z.object({
  name: AgentName,
  description: z.string().max(200).optional(),
  install: AgentInstall,
  auth: AgentAuth.optional().transform((a) => a ?? AgentAuth.parse({})),
  command: AgentCommand,
  /** Extra container environment (telemetry off, non-interactive mode). */
  env: z.record(EnvName, z.string()).default({}),
  capabilities: AgentCapabilities.prefault({}),
  /** `verified` means a real run on this machine produced the expected answer. */
  verified: z.boolean().default(false),
  origin: z.enum(["builtin", "user"]).default("user"),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** Input for `orbit agent add`: the definition without Orbit's own fields. */
export const AgentDefinitionInput = AgentDefinition.omit({ origin: true, verified: true });
export type AgentDefinitionInput = z.input<typeof AgentDefinitionInput>;

/** A registered Agent as the API shows it: the definition plus what this node can actually run. */
export const AgentInfo = z.object({
  definition: AgentDefinition,
  /** The CLI was found (or needs no lookup). */
  available: z.boolean(),
  /** Where it was found, or why it is missing. */
  detail: z.string(),
  version: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;
export const AgentList = z.object({ agents: z.array(AgentInfo) });
export type AgentList = z.infer<typeof AgentList>;

/** Templates use only the known placeholders; this catches typos before a run starts. */
export function templateError(template: string[]): string | null {
  for (const part of template)
    for (const m of part.matchAll(/\{[a-zA-Z]+\}/g))
      if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(m[0]))
        return `unknown placeholder ${m[0]}; use ${TEMPLATE_PLACEHOLDERS.join(" ")}`;
  return null;
}
