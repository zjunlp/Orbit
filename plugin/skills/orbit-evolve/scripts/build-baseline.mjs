// @ts-check
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{id: string, helpful: number, harmful: number, section: string, content: string}} Bullet
 * @typedef {{body: Buffer, executable: number}} File
 * @typedef {object} BaselineRequest
 * @property {"no-change" | "bounded-notes" | "ace"} variant
 * @property {string} parent
 * @property {string} out
 * @property {string} [base]
 * @property {{changedLines: number, changedBytes: number, noteLines?: number}} limits
 * @property {string[]} [notes]
 * @property {{id: string, tag: "helpful" | "harmful" | "neutral"}[]} [bulletTags]
 * @property {{type: "ADD", section: string, content: string}[]} [operations]
 */

const BEGIN = "<!-- orbit-ace:v1 -->";
const END = "<!-- /orbit-ace -->";
const SECTIONS = [
  "strategies_and_insights",
  "formulas_and_calculations",
  "code_snippets_and_templates",
  "common_mistakes_to_avoid",
  "problem_solving_heuristics",
  "context_clues_and_indicators",
  "others",
];

/** @param {unknown} n
 * @returns {asserts n is number} */
function positive(n) {
  assert(Number.isSafeInteger(n) && Number(n) > 0, "limits must be positive safe integers");
}
/** @param {unknown} value
 * @returns {asserts value is string} */
function line(value) {
  assert(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      !Array.from(value).some(
        (c) => c.charCodeAt(0) < 32 || [127, 8232, 8233].includes(c.charCodeAt(0)),
      ) &&
      !value.includes(BEGIN) &&
      !value.includes(END),
    "instruction content must be one nonempty text line without control characters or markers",
  );
}
/** @param {string} text */
function lines(text) {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}
/** @param {Bullet[]} bullets */
function render(bullets) {
  return `${BEGIN}\n## ACE playbook\n${SECTIONS.flatMap((section) => {
    const entries = bullets.filter((b) => b.section === section);
    return entries.length
      ? [
          `### ${section}`,
          ...entries.map(
            (b) => `[${b.id}] helpful=${b.helpful} harmful=${b.harmful} :: ${b.content}`,
          ),
        ]
      : [];
  }).join("\n")}\n${END}\n`;
}
/** @param {string} text */
function parsePlaybook(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) {
    assert(!text.includes(END), "orphan ACE marker");
    return { prefix: text, bullets: [] };
  }
  const prefix = text.slice(0, start);
  assert(!prefix || prefix.endsWith("\n"), "ACE block must begin on a new line");
  /** @type {Bullet[]} */
  const bullets = [];
  let section = "";
  for (const textLine of text.slice(start).split("\n").slice(2, -2)) {
    if (textLine.startsWith("### ")) {
      section = textLine.slice(4);
      assert(SECTIONS.includes(section), "unknown ACE section");
      continue;
    }
    const match = /^\[(ace-\d{5,})\] helpful=(\d+) harmful=(\d+) :: (.+)$/.exec(textLine);
    assert(match && section, "malformed ACE bullet");
    const [, id, h, bad, content] = match;
    assert(id && h && bad && content, "incomplete ACE bullet");
    line(content);
    assert(!bullets.some((b) => b.id === id), "duplicate ACE ID");
    assert(
      Number.isSafeInteger(Number(h)) && Number.isSafeInteger(Number(bad)),
      "invalid counters",
    );
    positive(Number(id.slice(4)));
    bullets.push({ id, helpful: Number(h), harmful: Number(bad), section, content });
  }
  assert(
    text.slice(start) === render(bullets),
    "ACE block must be canonical and at end of AGENTS.md",
  );
  return { prefix, bullets };
}

/** @param {string} parent
 * @param {BaselineRequest} request
 * @param {string} [base] */
export function buildInstruction(parent, request, base) {
  const { variant, limits } = request;
  positive(limits.changedLines);
  positive(limits.changedBytes);
  let next = parent;
  let totalNoteLines;
  if (variant === "no-change") {
    assert(
      !request.notes && !request.operations && !request.bulletTags && !request.base,
      "no-change does not accept edits or a base",
    );
  } else {
    assert(!parent || parent.endsWith("\n"), "parent AGENTS.md must end with LF before appending");
    assert(!parent.includes("\r") && !parent.includes("\0"), "AGENTS.md must be LF text");
    if (variant === "bounded-notes") {
      assert(!request.operations && !request.bulletTags, "notes do not accept ACE operations");
      positive(limits.noteLines);
      assert(
        base !== undefined && parent.startsWith(base),
        "parent must preserve the original base prefix",
      );
      assert(!base || base.endsWith("\n"), "base AGENTS.md must end with LF");
      const previous = parent.slice(base.length);
      assert(
        !previous ||
          previous
            .split("\n")
            .slice(0, -1)
            .every((s) => s.startsWith("- ")),
        "parent notes must remain append-only bullet lines",
      );
      assert(Array.isArray(request.notes) && request.notes.length > 0, "notes must not be empty");
      for (const note of request.notes) line(note);
      next += `${request.notes.map((note) => `- ${note}`).join("\n")}\n`;
      totalNoteLines = lines(next.slice(base.length));
      assert(totalNoteLines <= limits.noteLines, "cumulative note line limit exceeded");
    } else {
      assert(
        variant === "ace" && !request.notes && !request.base,
        "unknown or mixed baseline variant",
      );
      assert(
        Array.isArray(request.bulletTags) && Array.isArray(request.operations),
        "ACE needs tags and operations arrays",
      );
      const { prefix, bullets } = parsePlaybook(parent);
      const tagged = new Set();
      for (const tag of request.bulletTags) {
        const bullet = bullets.find((b) => b.id === tag.id);
        assert(
          bullet && !tagged.has(tag.id),
          "tag must reference one existing bullet exactly once",
        );
        assert(["helpful", "harmful", "neutral"].includes(tag.tag), "unknown bullet tag");
        tagged.add(tag.id);
        if (tag.tag !== "neutral") {
          bullet[tag.tag]++;
          assert(Number.isSafeInteger(bullet[tag.tag]), "counter overflow");
        }
      }
      let id = Math.max(0, ...bullets.map((b) => Number(b.id.slice(4)))) + 1;
      for (const op of request.operations) {
        assert(
          op.type === "ADD" && SECTIONS.includes(op.section),
          "only ADD to a known section is supported",
        );
        line(op.content);
        assert(
          !bullets.some((b) => b.content.toLowerCase() === op.content.toLowerCase()),
          "duplicate ACE content",
        );
        positive(id);
        bullets.push({
          id: `ace-${String(id++).padStart(5, "0")}`,
          helpful: 0,
          harmful: 0,
          section: op.section,
          content: op.content,
        });
      }
      assert(bullets.length > 0, "ACE produced no entries");
      next = prefix + render(bullets);
    }
    assert(next !== parent, "no candidate change; do not evaluate an unchanged proposal");
  }
  // Charge the entire changed span: a conservative upper bound on added + deleted diff lines.
  const before = parent.split("\n"),
    after = next.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let a = before.length,
    b = after.length;
  while (a > start && b > start && before[a - 1] === after[b - 1]) {
    a--;
    b--;
  }
  const changedLines = a + b - 2 * start;
  const changedBytes = next === parent ? 0 : Buffer.byteLength(next);
  assert(changedLines <= limits.changedLines, "changed line limit exceeded");
  assert(changedBytes <= limits.changedBytes, "changed file byte limit exceeded");
  return { text: next, changedLines, changedBytes, totalNoteLines };
}

/** @param {string} root */
function snapshot(root) {
  /** @type {Map<string, File>} */
  const files = new Map();
  let bytes = 0,
    entries = 0;
  /** @param {string} path
   * @param {number} depth */
  const visit = (path, depth) => {
    assert(depth <= 64 && ++entries <= 20000, "bundle tree limit exceeded");
    const full = join(root, path),
      st = lstatSync(full);
    assert(!st.isSymbolicLink(), "baseline helper does not follow symlinks");
    if (st.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(join(path, name), depth + 1);
    } else {
      assert(st.isFile(), "bundle contains a non-regular file");
      bytes += st.size;
      assert(bytes <= 64 * 1024 * 1024 && files.size < 2000, "bundle size limit exceeded");
      const body = readFileSync(full);
      assert(body.length === st.size, "bundle changed during snapshot");
      files.set(path, { body, executable: st.mode & 0o111 });
    }
  };
  assert(lstatSync(root).isDirectory(), "parent must be a real directory");
  visit("", 0);
  return files;
}
/** @param {Map<string, File>} files */
function instruction(files) {
  const bytes = files.get("AGENTS.md")?.body;
  assert(bytes, "baseline requires an existing AGENTS.md");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** @param {BaselineRequest} request */
export function buildBaseline(request) {
  assert(
    typeof request.parent === "string" && typeof request.out === "string",
    "parent and out paths required",
  );
  assert(!existsSync(request.out), "output already exists");
  const parent = realpathSync(request.parent);
  const out = join(realpathSync(dirname(resolve(request.out))), basename(resolve(request.out)));
  const rel = relative(parent, out);
  assert(rel === ".." || rel.startsWith(`..${sep}`), "output must be outside the parent bundle");
  const files = snapshot(parent);
  /** @type {string | undefined} */
  let base;
  if (request.variant === "bounded-notes") {
    assert(typeof request.base === "string", "bounded-notes requires the original base bundle");
    const baseRoot = realpathSync(request.base);
    const fromBase = relative(baseRoot, out);
    assert(
      fromBase === ".." || fromBase.startsWith(`..${sep}`),
      "output must be outside the original base",
    );
    const original = snapshot(baseRoot);
    assert(original.size === files.size, "base and parent file lists differ");
    for (const [name, file] of original) {
      const current = files.get(name);
      assert(
        current &&
          current.executable === file.executable &&
          (name === "AGENTS.md" || current.body.equals(file.body)),
        "non-note bundle content differs from base",
      );
    }
    base = instruction(original);
  }
  const result = buildInstruction(instruction(files), request, base);
  const agents = files.get("AGENTS.md");
  assert(agents);
  files.set("AGENTS.md", { ...agents, body: Buffer.from(result.text) });
  mkdirSync(out, { mode: 0o700 });
  try {
    for (const [name, file] of files) {
      mkdirSync(dirname(join(out, name)), { recursive: true, mode: 0o700 });
      writeFileSync(join(out, name), file.body, { flag: "wx", mode: 0o600 });
      chmodSync(join(out, name), 0o600 | file.executable);
    }
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
  return {
    variant: request.variant,
    out,
    changedLines: result.changedLines,
    changedBytes: result.changedBytes,
    totalNoteLines: result.totalNoteLines,
    files: files.size,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 3, "usage: node build-baseline.mjs /absolute/request.json");
    assert(process.argv[2]);
    const path = resolve(process.argv[2]);
    assert(lstatSync(path).size <= 1024 * 1024, "request exceeds 1 MiB");
    const request = JSON.parse(readFileSync(path, "utf8"));
    for (const key of ["parent", "out", "base"])
      if (typeof request[key] === "string") request[key] = resolve(dirname(path), request[key]);
    console.log(JSON.stringify(buildBaseline(request), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "baseline build failed");
    process.exitCode = 1;
  }
}
