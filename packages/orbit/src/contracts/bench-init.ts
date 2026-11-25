import { z } from "zod";
import { ProfileName } from "./common.ts";

export const BenchInitRequest = z.strictObject({
  name: ProfileName,
  directory: z.string().min(1).max(4096),
  template: z.enum(["adapter", "manifest"]).default("adapter"),
});
export type BenchInitRequest = z.infer<typeof BenchInitRequest>;
export const BenchInitResult = BenchInitRequest.extend({
  files: z.array(z.string()),
  nextSteps: z.array(z.string()),
  tutorial: z.literal(true),
});
export type BenchInitResult = z.infer<typeof BenchInitResult>;
