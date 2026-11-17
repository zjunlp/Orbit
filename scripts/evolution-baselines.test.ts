import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectBundle } from "../packages/orbit/src/lib/bundle.ts";
import {
  type BaselineRequest,
  buildBaseline,
  buildInstruction,
} from "../plugin/skills/orbit-evolve/scripts/build-baseline.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(variant: BaselineRequest["variant"] = "no-change") {
  const root = mkdtempSync(join(tmpdir(), "orbit-baseline-"));
  roots.push(root);
  const parent = join(root, "parent");
  mkdirSync(join(parent, "skills/tool"), { recursive: true });
  writeFileSync(join(parent, "AGENTS.md"), "Preserve the user's constraints.\n");
  writeFileSync(join(parent, "skills/tool/run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(parent, "skills/tool/run.sh"), 0o755);
  writeFileSync(join(parent, "config.toml"), "model = 'unchanged'\n");
  const request: BaselineRequest = {
    variant,
    parent,
    out: join(root, "child"),
    limits: { changedLines: 30, changedBytes: 4096, noteLines: 3 },
  };
  return { root, parent, request };
}
const addition = (content: string) => ({
  type: "ADD" as const,
  section: "strategies_and_insights",
  content,
});

it("copies no-change bytes and executable bits with the exact Orbit revision digest", () => {
  const { parent, request } = setup();
  writeFileSync(join(parent, "AGENTS.md"), "\ufeffKeep exact bytes.\r\n");
  const before = inspectBundle(parent);
  const result = buildBaseline(request);
  expect(result).toMatchObject({ changedLines: 0, changedBytes: 0 });
  expect(inspectBundle(request.out)).toEqual(before);
  expect(inspectBundle(parent)).toEqual(before);
});

it("bounds accumulated notes across rounds and preserves all other bundle files", () => {
  const { parent, request } = setup("bounded-notes");
  const original = inspectBundle(parent);
  request.base = parent;
  request.notes = ["Check required inputs.", "Verify environment feedback."];
  expect(buildBaseline(request)).toMatchObject({ changedLines: 2, totalNoteLines: 2 });
  const second = {
    ...request,
    parent: request.out,
    out: `${request.out}-2`,
    notes: ["Stop when done."],
  };
  expect(buildBaseline(second)).toMatchObject({ changedLines: 1, totalNoteLines: 3 });
  const overflow = {
    ...second,
    parent: second.out,
    out: `${request.out}-3`,
    notes: ["Another note."],
  };
  expect(() => buildBaseline(overflow)).toThrow(/cumulative/);
  expect(existsSync(overflow.out)).toBe(false);
  expect(inspectBundle(parent)).toEqual(original);
  for (const file of ["config.toml", "skills/tool/run.sh"])
    expect(readFileSync(join(second.out, file))).toEqual(readFileSync(join(parent, file)));
});

it("rejects rewriting an old note or changing another file relative to the notes base", () => {
  const { parent, request } = setup("bounded-notes");
  request.base = parent;
  request.notes = ["Check input."];
  buildBaseline(request);
  writeFileSync(join(request.out, "config.toml"), "model = 'other'\n");
  expect(() => buildBaseline({ ...request, parent: request.out, out: `${request.out}-2` })).toThrow(
    /non-note/,
  );
  expect(() =>
    buildInstruction("Rewritten instructions.\n", request, "Original instructions.\n"),
  ).toThrow(/prefix/);
});

it("rejects multiline notes, byte overflow and changed-line overflow before creating output", () => {
  const { parent, request } = setup("bounded-notes");
  request.base = parent;
  for (const note of ["a\nb", "a\rb", "a\u2028b", "a\0b"])
    expect(() => buildBaseline({ ...request, notes: [note] })).toThrow(/one nonempty/);
  expect(() => buildBaseline({ ...request, notes: ["x".repeat(4096)] })).toThrow(/byte limit/);
  expect(() =>
    buildBaseline({
      ...request,
      notes: ["One.", "Two."],
      limits: { ...request.limits, changedLines: 1 },
    }),
  ).toThrow(/line limit/);
  expect(existsSync(request.out)).toBe(false);
});

it("performs ACE incremental ADD and feedback without rewriting earlier content or base instructions", () => {
  const { parent, request } = setup("ace");
  request.bulletTags = [];
  request.operations = [addition("Inspect current state before dependent actions.")];
  const original = readFileSync(join(parent, "AGENTS.md"), "utf8");
  buildBaseline(request);
  const first = readFileSync(join(request.out, "AGENTS.md"), "utf8");
  expect(first.startsWith(original)).toBe(true);
  expect(first).toContain(
    "[ace-00001] helpful=0 harmful=0 :: Inspect current state before dependent actions.",
  );
  const second = {
    ...request,
    parent: request.out,
    out: `${request.out}-2`,
    bulletTags: [{ id: "ace-00001", tag: "helpful" as const }],
    operations: [addition("Preserve user constraints when tools are limited.")],
  };
  buildBaseline(second);
  const next = readFileSync(join(second.out, "AGENTS.md"), "utf8");
  expect(next.startsWith(original)).toBe(true);
  expect(next).toContain(
    "[ace-00001] helpful=1 harmful=0 :: Inspect current state before dependent actions.",
  );
  expect(next).toContain(
    "[ace-00002] helpful=0 harmful=0 :: Preserve user constraints when tools are limited.",
  );
  expect(readFileSync(join(request.out, "AGENTS.md"), "utf8")).toBe(first);
  expect(inspectBundle(second.out).digest).not.toBe(inspectBundle(request.out).digest);
});

it("rejects unsupported, duplicate, malformed and empty ACE updates", () => {
  const { request } = setup("ace");
  request.bulletTags = [];
  request.operations = [addition("Check state.")];
  const first = buildInstruction("Base.\n", request).text;
  expect(() => buildInstruction(first, request)).toThrow(/duplicate ACE content/);
  expect(() =>
    buildInstruction(first, {
      ...request,
      operations: [],
      bulletTags: [{ id: "missing", tag: "helpful" }],
    }),
  ).toThrow(/existing bullet/);
  expect(() =>
    buildInstruction(first, {
      ...request,
      operations: [],
      bulletTags: [{ id: "ace-00001", tag: "neutral" }],
    }),
  ).toThrow(/no candidate change/);
  expect(() => buildInstruction("Base.\n", { ...request, operations: [] })).toThrow(/no entries/);
  expect(() =>
    buildInstruction(first, {
      ...request,
      operations: [{ ...addition("Edit."), type: "DELETE" } as never],
    }),
  ).toThrow(/only ADD/);
  expect(() =>
    buildInstruction(`${first}Hidden after block.\n`, { ...request, operations: [] }),
  ).toThrow();
  expect(() => buildInstruction(first.replace("helpful=0", "helpful=NaN"), request)).toThrow(
    /malformed/,
  );
});

it("does not overwrite an existing output, follow links or write inside the parent", () => {
  const { root, parent, request } = setup();
  expect(() => buildBaseline({ ...request, out: parent })).toThrow(/already exists/);
  expect(() => buildBaseline({ ...request, out: join(parent, "child") })).toThrow(/outside/);
  symlinkSync(join(root, "missing"), join(parent, "link"));
  expect(() => buildBaseline(request)).toThrow(/symlinks/);
  expect(existsSync(request.out)).toBe(false);
});

it("runs with plain Node outside the checkout and resolves request-relative paths", () => {
  const { root } = setup();
  const script = resolve("plugin/skills/orbit-evolve/scripts/build-baseline.mjs");
  const path = join(root, "request.json");
  writeFileSync(
    path,
    JSON.stringify({
      variant: "no-change",
      parent: "parent",
      out: "child",
      limits: { changedLines: 1, changedBytes: 1 },
    }),
  );
  const result = JSON.parse(
    execFileSync(process.execPath, [script, path], { cwd: tmpdir(), encoding: "utf8" }),
  );
  expect(result.variant).toBe("no-change");
  expect(inspectBundle(join(root, "parent"))).toEqual(inspectBundle(join(root, "child")));
});
