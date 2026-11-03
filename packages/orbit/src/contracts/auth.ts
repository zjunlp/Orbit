import { z } from "zod";
import { AgentName } from "./agent.ts";
import { AuthKind, EnvName, ProfileName } from "./common.ts";

/**
 * The Agent a profile is for (`contracts/agent.ts`). Built-ins are `codex` and `claude-code`;
 * registered definitions use their own names. Kept as an alias so older imports keep working.
 */
export const Harness = AgentName;
export type Harness = z.infer<typeof Harness>;
export { AuthKind } from "./common.ts";
/** Public view of a credential profile for an Agent CLI inside containers. Never contains the secret. */
export const AuthProfile = z.object({
  name: ProfileName,
  harness: Harness,
  kind: AuthKind,
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
  /** Extra non-secret variables for the container (proxy, model aliases). */
  env: z.record(EnvName, z.string()).default({}),
  /** Runs using this profile share the host network (e.g. a proxy on 127.0.0.1). */
  hostNetwork: z.boolean().default(false),
  /** Masked hint of the stored secret, e.g. `sk-…a1b2`. */
  secretHint: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AuthProfile = z.infer<typeof AuthProfile>;

/**
 * Create or replace a profile. `secret` is the API key / token; for codex `login` it is the content
 * of a Codex `auth.json`.
 */
export const AuthProfileInput = AuthProfile.pick({
  name: true,
  harness: true,
  kind: true,
  baseUrl: true,
  model: true,
  env: true,
  hostNetwork: true,
})
  .extend({ secret: z.string().min(1) })
  .refine((p) => p.kind !== "relay" || Boolean(p.baseUrl), {
    message: "relay profiles need baseUrl",
  });
export type AuthProfileInput = z.input<typeof AuthProfileInput>;

export const AuthTestResult = z.object({
  ok: z.boolean(),
  runId: z.string(),
  detail: z.string(),
});
export type AuthTestResult = z.infer<typeof AuthTestResult>;

export const NotifyEvent = z.enum(["succeeded", "failed", "group"]);
export type NotifyEvent = z.infer<typeof NotifyEvent>;
const NotifyOn = z.array(NotifyEvent).min(1).default(["succeeded", "failed", "group"]);
export const WebhookKind = z.enum(["feishu", "dingtalk", "wecom", "slack", "webhook"]);
export const FEISHU_APP = "feishu-app";
export const WebhookTargetInput = z.object({
  name: ProfileName,
  kind: WebhookKind,
  url: z.string().url(),
  on: NotifyOn,
});
/**
 * A Feishu self-built app: the daemon holds an outbound long connection to Feishu, answers
 * read-only commands from paired users and sends them cards.
 */
export const FeishuAppTargetInput = z.object({
  name: ProfileName,
  kind: z.literal(FEISHU_APP),
  appId: z.string().regex(/^cli_[0-9a-fA-F]{16}$/, "appId looks like cli_ and 16 hex digits"),
  appSecret: z.string().min(1),
  /** open_id of paired users (`orbit notify pair`); kept when the target is replaced. */
  users: z.array(z.string().min(1)).optional(),
  on: NotifyOn,
});
export const NotifyTargetInput = z.discriminatedUnion("kind", [
  WebhookTargetInput,
  FeishuAppTargetInput,
]);
export type NotifyTargetInput = z.input<typeof NotifyTargetInput>;
/** Public view: webhook URLs usually embed a token, so only their origin is shown. */
export const NotifyTarget = z.object({
  name: ProfileName,
  kind: z.union([WebhookKind, z.literal(FEISHU_APP)]),
  on: z.array(NotifyEvent),
  /** Webhook URL origin, or the app id of a Feishu app. */
  urlHint: z.string(),
  /** Feishu app: paired users and the state of its long connection. */
  users: z.number().int().optional(),
  connection: z.enum(["connecting", "connected", "failed", "stopped"]).optional(),
});
export type NotifyTarget = z.infer<typeof NotifyTarget>;
export const NotifyPairInput = z.object({ code: z.string().regex(/^\d{6}$/) });
