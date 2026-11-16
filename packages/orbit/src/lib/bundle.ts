import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

export const BUNDLE_MAX_FILES = 2000;
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

/** Hash exactly the paths, executable bits and bytes installed from a method bundle. */
export function inspectBundle(
  directory: string,
  visit?: (file: string, body: Buffer) => void,
  options: { maxFiles?: number; maxBytes?: number; confined?: boolean } = {},
) {
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error("method bundle must be a directory");
  const hash = createHash("sha256");
  const ancestors = new Set<string>();
  let files = 0,
    bytes = 0,
    entries = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 64) throw new Error("method bundle exceeds 64 directory levels");
    const real = realpathSync(dir);
    const inside = relative(root, real);
    if (options.confined && (inside === ".." || inside.startsWith(`..${sep}`)))
      throw new Error("method bundle contains a link outside its directory");
    if (ancestors.has(real)) throw new Error("method bundle contains a symlink cycle");
    const stat = statSync(real);
    if (stat.isDirectory()) {
      ancestors.add(real);
      for (const name of readdirSync(dir).sort()) {
        if (++entries > 20000) throw new Error("method bundle exceeds 20000 directory entries");
        walk(join(dir, name), depth + 1);
      }
      ancestors.delete(real);
      return;
    }
    if (!stat.isFile()) throw new Error("method bundle contains a non-regular file");
    if (++files > (options.maxFiles ?? BUNDLE_MAX_FILES))
      throw new Error(`method bundle has over ${options.maxFiles ?? BUNDLE_MAX_FILES} files`);
    const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) throw new Error("method bundle contains a non-regular file");
      if (bytes + before.size > (options.maxBytes ?? BUNDLE_MAX_BYTES))
        throw new Error(
          (options.maxBytes ?? BUNDLE_MAX_BYTES) === BUNDLE_MAX_BYTES
            ? "method bundle is over 64 MiB"
            : "method bundle exceeds its byte limit",
        );
      const body = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < body.length) {
        const count = readSync(fd, body, offset, body.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      const after = fstatSync(fd);
      if (offset !== before.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode)
        throw new Error("method bundle changed during inspection");
      const data = body.subarray(0, offset);
      const file = relative(directory, dir);
      bytes += offset;
      hash
        .update(file)
        .update("\0")
        .update(String(before.mode & 0o111))
        .update("\0")
        .update(String(offset))
        .update("\0")
        .update(data);
      visit?.(file, data);
    } finally {
      closeSync(fd);
    }
  };
  walk(directory, 0);
  return { digest: hash.digest("hex"), files, bytes };
}
