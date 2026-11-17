// @ts-check
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** @typedef {{path: string, body: string | null}} Entry */
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_ENTRIES = 512;
/** @param {string | Buffer} body */
export const sha256 = (body) => createHash("sha256").update(body).digest("hex");
/** @param {string} path */
export function safePath(path) {
  assert(
    typeof path === "string" &&
      path.length <= 1024 &&
      path.split("/").every((p) => p && p !== "." && p !== "..") &&
      !path.includes("\\") &&
      !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    "unsafe relative path",
  );
  return path;
}
/** @param {string} root
 * @param {number} [limit]
 * @returns {Entry[]} */
export function snapshot(root, limit = MAX_BYTES) {
  /** @type {Entry[]} */
  const entries = [];
  let bytes = 0;
  /** @param {string} path */
  const walk = (path) => {
    assert(path.split("/").length <= 32 && entries.length < MAX_ENTRIES, "tree limit exceeded");
    const full = join(root, path),
      st = lstatSync(full);
    assert(!st.isSymbolicLink(), "symlinks are not allowed");
    if (st.isDirectory()) {
      if (path) entries.push({ path: safePath(path), body: null });
      for (const name of readdirSync(full).sort()) walk(path ? `${path}/${name}` : name);
    } else {
      assert(st.isFile() && st.nlink === 1, "only private regular files are allowed");
      assert(!(st.mode & 0o111), "executable files are not instruction text");
      bytes += st.size;
      assert(bytes <= limit, "input size limit exceeded");
      const body = readFileSync(full);
      assert(body.length === st.size, "input changed during snapshot");
      entries.push({ path: safePath(path), body: body.toString("base64") });
    }
  };
  assert(lstatSync(root).isDirectory(), "input must be a real directory");
  walk("");
  return entries;
}
/** @param {unknown} input
 * @returns {Entry[]} */
export function instructionEntries(input) {
  assert(
    Array.isArray(input) && input.length > 0 && input.length <= MAX_ENTRIES,
    "invalid bundle entries",
  );
  const seen = new Set();
  let bytes = 0,
    files = 0;
  for (const e of input) {
    assert(
      e && typeof e === "object" && Object.keys(e).sort().join() === "body,path",
      "invalid bundle entry",
    );
    safePath(e.path);
    assert(!seen.has(e.path), "duplicate bundle path");
    seen.add(e.path);
    assert(e.path.split("/").length <= 32, "bundle depth exceeded");
    if (e.body === null) {
      assert(e.path === "skills" || e.path.startsWith("skills/"), "unexpected bundle directory");
    } else {
      assert(
        e.path === "AGENTS.md" ||
          e.path === "CLAUDE.md" ||
          (e.path.startsWith("skills/") && e.path.endsWith(".md")),
        "only instruction Markdown files are supported",
      );
      assert(typeof e.body === "string" && e.body.length <= MAX_BYTES * 2, "invalid file body");
      const body = Buffer.from(e.body, "base64");
      assert(body.toString("base64") === e.body, "noncanonical file encoding");
      bytes += body.length;
      assert(bytes <= MAX_BYTES, "bundle byte limit exceeded");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      assert(!text.includes("\0"), "bundle must be UTF-8 text");
      files++;
    }
  }
  assert(files > 0, "empty instruction bundle");
  for (const e of input) {
    const parts = e.path.split("/");
    while (parts.length > 1) {
      parts.pop();
      assert(
        input.some((d) => d.path === parts.join("/") && d.body === null),
        "missing bundle directory",
      );
    }
  }
  return input;
}
/** @param {string} root
 * @param {Entry[]} entries */
export function writeSnapshot(root, entries) {
  mkdirSync(root, { mode: 0o700 });
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const path = join(root, safePath(e.path));
    if (e.body === null) mkdirSync(path, { recursive: true, mode: 0o700 });
    else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(e.body, "base64"), { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    }
  }
}
/** @param {Entry[]} before
 * @param {Entry[]} after
 * @param {{changedLines: number, changedBytes: number}} limits */
export function checkChanges(before, after, limits) {
  const old = new Map(before.filter((e) => e.body !== null).map((e) => [e.path, e.body]));
  const next = new Map(after.filter((e) => e.body !== null).map((e) => [e.path, e.body]));
  let changedLines = 0,
    changedBytes = 0;
  for (const path of new Set([...old.keys(), ...next.keys()])) {
    if (old.get(path) === next.get(path)) continue;
    const a = Buffer.from(old.get(path) ?? "", "base64"),
      b = Buffer.from(next.get(path) ?? "", "base64");
    const left = a.toString("utf8").split("\n"),
      right = b.toString("utf8").split("\n");
    let start = 0,
      endA = left.length,
      endB = right.length;
    while (start < endA && start < endB && left[start] === right[start]) start++;
    while (endA > start && endB > start && left[endA - 1] === right[endB - 1]) {
      endA--;
      endB--;
    }
    changedLines += endA + endB - 2 * start;
    changedBytes += b.length || a.length;
  }
  assert(changedLines > 0, "no instruction change");
  assert(
    changedLines <= limits.changedLines && changedBytes <= limits.changedBytes,
    "candidate exceeds change budget",
  );
  return { changedLines, changedBytes };
}
