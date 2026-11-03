import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { CodeSnapshot } from "../contracts/index.ts";
import { exec } from "../lib/exec.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const MAX_SNAPSHOT_BYTES = 2 * 1024 ** 3;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const r = await exec("git", ["-C", cwd, ...args], { timeoutMs: 120_000, env });
  return r;
}

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  const r = await git(cwd, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Which version of a directory's repository is checked out: commit, the tag `git describe` gives,
 * and whether tracked files changed. Null outside a git repository.
 */
export async function gitSource(
  dir: string,
): Promise<{ commit: string; describe: string | null; dirty: boolean } | null> {
  const commit = await gitOut(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!commit) return null;
  const describe = await gitOut(dir, ["describe", "--tags", "--always", "--dirty"]);
  const status = await gitOut(dir, ["status", "--porcelain", "--untracked-files=no", "--", "."]);
  return { commit, describe, dirty: Boolean(status) };
}

/**
 * Copy the working tree of `project`'s repository (tracked + untracked, respecting .gitignore)
 * into `dest`, and write the full change set relative to HEAD to `diffFile`.
 * The original repository, its index and its refs are not modified.
 */
export async function snapshotProject(
  project: string,
  dest: string,
  diffFile: string,
): Promise<CodeSnapshot> {
  const abs = resolve(project);
  const root = await gitOut(abs, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(`${abs} is not inside a git repository`);
  const commit = await gitOut(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = commit ? await gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;

  const ls = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  if (ls.code !== 0) throw new Error(`git ls-files failed: ${ls.stderr.trim()}`);
  const files = ls.stdout.split("\0").filter(Boolean);
  const staged = await git(root, ["ls-files", "--stage", "-z"]);
  if (staged.code !== 0) throw new Error(`git ls-files failed: ${staged.stderr.trim()}`);
  const submodules = new Set(
    staged.stdout
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );

  let bytes = 0;
  let fileCount = 0;
  await mkdir(dest, { recursive: true });
  for (const f of files) {
    if (submodules.has(f)) continue;
    const src = join(root, f);
    const st = await lstat(src).catch(() => null);
    if (!st) continue; // tracked but deleted in the working tree
    if (st.isDirectory()) {
      submodules.add(f.replace(/\/$/, ""));
      continue;
    }
    const out = join(dest, f);
    await mkdir(dirname(out), { recursive: true });
    if (st.isSymbolicLink()) {
      await symlink(await readlink(src), out);
    } else if (st.isFile()) {
      bytes += st.size;
      if (bytes > MAX_SNAPSHOT_BYTES) {
        throw new Error(
          `snapshot exceeds ${MAX_SNAPSHOT_BYTES / 1024 ** 3} GiB; gitignore data/weights and mount them instead`,
        );
      }
      await copyFile(src, out, constants.COPYFILE_FICLONE);
    } else continue;
    fileCount++;
  }

  // Both the index and newly written blobs stay outside the user's repository.
  const realIndex = await gitOut(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  const realObjects = await gitOut(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "objects",
  ]);
  if (!realObjects) throw new Error("git object directory not found");
  const temp = await mkdtemp(join(tmpdir(), "orbit-snapshot-"));
  try {
    const tmpIndex = join(temp, "index");
    const objects = join(temp, "objects");
    await mkdir(objects);
    if (realIndex) {
      const indexStat = await stat(realIndex).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (indexStat) {
        await copyFile(realIndex, tmpIndex);
        // Git uses the index timestamp to detect same-size edits with matching cached stats.
        await utimes(tmpIndex, indexStat.atime, indexStat.mtime);
      }
    }
    const alternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    const env = {
      ...process.env,
      GIT_INDEX_FILE: tmpIndex,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: `${JSON.stringify(realObjects)}${alternates ? `:${alternates}` : ""}`,
    };
    const add = await git(root, ["add", "-A"], env);
    if (add.code !== 0) throw new Error(`git add (temp index) failed: ${add.stderr.trim()}`);
    const diff = await git(
      root,
      ["diff", "--cached", "--binary", "--no-color", commit ?? EMPTY_TREE],
      env,
    );
    const names = await git(
      root,
      ["diff", "--cached", "--name-only", "-z", commit ?? EMPTY_TREE],
      env,
    );
    if (names.code !== 0) throw new Error(`git diff (temp index) failed: ${names.stderr.trim()}`);
    // The snapshot itself is complete; a diff git could not produce (e.g. too large) is marked.
    await writeFile(
      diffFile,
      diff.code === 0
        ? diff.stdout
        : `${diff.stdout}\n# orbit: diff incomplete: ${diff.stderr.trim().slice(0, 500)}\n`,
    );
    const changedFiles = names.stdout.split("\0").filter(Boolean);
    return {
      repo: root,
      subdir: relative(root, abs),
      commit,
      branch,
      dirty: changedFiles.length > 0,
      changedFiles,
      skippedSubmodules: [...submodules].sort(),
      fileCount,
      bytes,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
