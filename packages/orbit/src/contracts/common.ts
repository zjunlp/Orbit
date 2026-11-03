import { z } from "zod";

export const API_PREFIX = "/api/v1";

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
});
export type Health = z.infer<typeof Health>;

export const LoginCode = z.object({
  code: z.string().regex(/^[0-9a-f]{48}$/),
  expiresAt: z.iso.datetime(),
});
export type LoginCode = z.infer<typeof LoginCode>;

export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;

export const ProfileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "use letters, digits, '.', '_' or '-'");

/** How an Agent authenticates: an interactive login, an API key, or a relay endpoint with a key. */
export const AuthKind = z.enum(["login", "api-key", "relay"]);
export type AuthKind = z.infer<typeof AuthKind>;

export const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid environment variable name");
