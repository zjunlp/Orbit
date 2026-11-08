// Method revisions (design §9.16): what a method is made of, hashed, so results of the same content
// line up across jobs and a changed bundle, model or CLI is a new revision even under the same name.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Method, MethodBasis, MethodRevision } from "../contracts/index.ts";
import { contentDigest } from "./samples.ts";

/** Bundles are small (instructions, skills); stop rather than hash a whole checkout by mistake. */
const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;

/** Digest the files installed into the Agent home, following bundle links like the installer. */
export function bundleDigest(dir: string): string {
  const h = createHash("sha256");
  const ancestors = new Set<string>();
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    const real = realpathSync(d);
    if (ancestors.has(real)) throw new Error("method bundle contains a symlink cycle");
    ancestors.add(real);
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        if (++files > MAX_FILES) throw new Error(`method bundle has over ${MAX_FILES} files`);
        bytes += st.size;
        if (bytes > MAX_BYTES) throw new Error("method bundle is over 64 MiB");
        const body = readFileSync(p);
        h.update(relative(dir, p))
          .update("\0")
          .update(String(st.mode & 0o111))
          .update("\0")
          .update(String(body.length))
          .update("\0")
          .update(body);
      } else throw new Error("method bundle contains a non-regular file");
    }
    ancestors.delete(real);
  };
  walk(dir);
  return h.digest("hex");
}

/** Stable JSON: object keys sorted, so the same basis always hashes the same. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 12);
}

export function revisionOf(basis: MethodBasis, approximate = false): MethodRevision {
  const revision = stableDigest(basis);
  return { revision, basis, approximate };
}

/**
 * The basis of a method. `cliVersion` and `bundleDigest` are what the submitting node sees; for an
 * older job without them pass null (the revision is then marked approximate).
 */
export function methodBasis(
  m: Method,
  extra: { authKind: string | null; cliVersion: string | null; bundleDigest: string | null },
): MethodBasis {
  return {
    agent: m.agent,
    model: m.model ?? null,
    effort: m.effort ?? null,
    authKind: extra.authKind,
    cliVersion: extra.cliVersion,
    bundleDigest: extra.bundleDigest,
    entrypoint: m.entrypoint ?? null,
    config: m.config && Object.keys(m.config).length ? m.config : null,
    ...(m.agent === "policy" && m.policySnapshot
      ? { policyDigest: contentDigest(m.policySnapshot) }
      : {}),
  };
}
