// Host-side file access below directories a run's container can also write (its output, the Agent
// home). The container may plant symlinks there; the daemon must never follow them out.
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Make `dir` and every directory between `root` and it a real directory: a symlink or file planted
 * on the way is removed instead of followed.
 */
export function realDirs(root: string, dir: string): void {
  const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${dir} leaves ${root}`);
  let at = root;
  for (const part of ["", ...(rel ? rel.split(sep) : [])]) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) rmSync(at, { force: true });
    if (!st?.isDirectory()) mkdirSync(at);
  }
}

/** A regular file's text; "" when missing or not a regular file (never follows a symlink). */
export function readRegular(file: string): string {
  const st = lstatSync(file, { throwIfNoEntry: false });
  return st?.isFile() ? readFileSync(file, "utf8") : "";
}

/** Replace `file` with a private (0600) file; a symlink at `file` is replaced, not written through. */
export function writePrivateFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.orbit-tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Copy `src` (trusted; its links are followed) into `dest`, replacing links planted in `dest` instead
 * of writing through them.
 */
export function copyTreeInto(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const st = statSync(from);
    const there = lstatSync(to, { throwIfNoEntry: false });
    if (st.isDirectory()) {
      if (there && !there.isDirectory()) rmSync(to, { force: true });
      copyTreeInto(from, to);
    } else if (st.isFile()) {
      if (there) rmSync(to, { recursive: true, force: true });
      copyFileSync(from, to);
    }
  }
}
