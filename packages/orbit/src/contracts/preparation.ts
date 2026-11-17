import { z } from "zod";
import { BenchIdentity, BenchmarkInput } from "./bench.ts";
import { EnvName, ProfileName } from "./common.ts";
import { Run } from "./runs.ts";

const AbsolutePath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith("/"), "use an absolute path on the daemon's machine");
export const PreparationResource = z.object({
  id: ProfileName,
  label: z.string(),
  kind: z.enum(["git", "file", "huggingface", "manual"]),
  url: z.url(),
  revision: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  filename: z.string().optional(),
  includes: z.array(z.string()).optional(),
  access: z.enum(["public", "authorization"]).default("public"),
  instructions: z.string(),
  authorizationUrl: z.url().optional(),
});
export type PreparationResource = z.infer<typeof PreparationResource>;
export const PreparationField = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["path", "text", "image"]),
  help: z.string(),
  default: z.string().optional(),
  required: z.boolean().default(true),
});
export type PreparationField = z.infer<typeof PreparationField>;
export const PreparationRecipe = z.object({
  id: BenchIdentity.shape.id,
  name: z.string(),
  guide: z.url(),
  description: z.string(),
  resources: z.array(PreparationResource),
  fields: z.array(PreparationField),
  steps: z.array(z.string()),
  registrationNames: z.array(z.string()).default([]),
});
export type PreparationRecipe = z.infer<typeof PreparationRecipe>;
export const PreparationCatalog = z.object({
  recipes: z.array(PreparationRecipe),
  directory: z.string(),
});
export type PreparationCatalog = z.infer<typeof PreparationCatalog>;
export const PreparationInput = z.strictObject({
  name: ProfileName.optional(),
  directory: AbsolutePath.optional(),
  reuse: z.record(z.string(), AbsolutePath).default({}),
  values: z.record(z.string(), z.string().max(4096)).default({}),
  authorized: z.array(z.string()).default([]),
  registrationFile: AbsolutePath.optional(),
  proxy: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    }, "use an HTTP proxy without embedded credentials")
    .optional(),
  tokenEnv: EnvName.optional(),
});
export type PreparationInput = z.input<typeof PreparationInput>;
export const PreparedResources = z.object({
  resources: z.record(z.string(), z.string()),
  definitions: z.array(BenchmarkInput),
  datasets: z.array(z.object({ name: ProfileName, path: AbsolutePath })),
  pending: z.array(z.string()),
});
export type PreparedResources = z.infer<typeof PreparedResources>;
export const PreparationStatus = z.object({
  run: Run,
  family: z.string(),
  input: PreparationInput.optional(),
  state: z.enum(["running", "needs_input", "registered", "failed", "cancelled"]),
  registrations: z.array(z.string()),
  pending: z.array(z.string()),
  resources: z.record(z.string(), z.string()),
});
export type PreparationStatus = z.infer<typeof PreparationStatus>;
