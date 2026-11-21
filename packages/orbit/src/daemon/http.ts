import type { Context } from "hono";
import { z } from "zod";
import { AuthError } from "../auth/index.ts";
import { NotifyError } from "../notify/index.ts";
import { NotFoundError, UserError } from "../runs/service.ts";

/** Call the run's node; an unreachable node is a 502 with the reason. */
export async function remoteRecords<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new BadGateway(`node unavailable: ${(e as Error).message}`);
  }
}

class BadGateway extends Error {}

export function must<T>(v: T | null): T {
  if (v === null) throw new NotFoundError("not found");
  return v;
}

export function errorResponse(c: Context, err: Error): Response {
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof BadGateway) return c.json({ error: err.message }, 502);
  if (err instanceof UserError || err instanceof AuthError || err instanceof NotifyError)
    return c.json({ error: err.message }, 400);
  if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
  if (err instanceof SyntaxError) return c.json({ error: `invalid JSON: ${err.message}` }, 400);
  if (err instanceof URIError) return c.json({ error: `invalid path: ${err.message}` }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
}

/** A non-negative safe integer query parameter, or the default when absent. */
export function num(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new UserError("query number must be a non-negative safe integer");
  return n;
}

/** A signed safe integer query parameter, or the default when absent. */
export function signed(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new UserError("query number must be a safe integer");
  return n;
}
