import { describe, expect, it } from "vitest";
import { parseDiff, splitRows } from "../src/lib/diff.ts";
import { ema, stats } from "../src/lib/ema.ts";
import { folderError, folderTree } from "../src/lib/folders.ts";
import { canReadMoreLogs, collapseCR, stripAnsi, toLines } from "../src/lib/log.ts";

const PATCH = `diff --git a/train.py b/train.py
index 111..222 100644
--- a/train.py
+++ b/train.py
@@ -1,3 +1,4 @@
 import torch
-lr = 1e-3
+lr = 3e-4
+warmup = 100
 print(lr)
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

describe("parseDiff", () => {
  it("parses files, statuses and counts", () => {
    const files = parseDiff(PATCH);
    expect(files.map((f) => [f.newPath, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ["train.py", "modified", 2, 1, false],
      ["new.txt", "added", 1, 0, false],
      ["img.png", "modified", 0, 0, true],
    ]);
  });
  it("pairs deletions with additions in split rows", () => {
    const f = parseDiff(PATCH)[0];
    const rows = splitRows(f?.hunks[0]?.lines ?? []);
    const changed = rows.find((r) => r.left?.type === "del");
    expect(changed?.right?.text).toBe("lr = 3e-4");
  });
});

describe("log", () => {
  it("pauses at a withheld secret tail but continues through redacted empty windows", () => {
    expect(canReadMoreLogs({ offset: 0, next: 20, size: 100, text: "", eof: false })).toBe(true);
    expect(canReadMoreLogs({ offset: 80, next: 80, size: 100, text: "", eof: false })).toBe(false);
    expect(
      canReadMoreLogs({ offset: 80, next: 100, size: 100, text: "[redacted]", eof: true }),
    ).toBe(false);
  });
  it("collapses carriage-return progress bars", () => {
    expect(collapseCR("10%\r50%\r100%")).toBe("100%");
  });
  it("strips ansi and classifies lines", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    const lines = toLines("[orbit] started\nTraceback (most recent call last):\nok", 5);
    expect(lines.map((l) => [l.n, l.kind])).toEqual([
      [5, "sys"],
      [6, "err"],
      [7, "out"],
    ]);
  });
});

describe("ema", () => {
  it("is debiased and identity at weight 0", () => {
    expect(ema([1, 2, 3], 0)).toEqual([1, 2, 3]);
    expect(ema([5, 5, 5], 0.9)[0]).toBeCloseTo(5);
  });
  it("computes stats", () => {
    const s = stats([1, 2, 3]);
    expect([s.min, s.max, s.mean]).toEqual([1, 3, 2]);
    expect(s.std).toBeCloseTo(1);
  });
});

describe("report paths", () => {
  it("joins relative paths inside the run and refuses to climb out", async () => {
    const { joinPath } = await import("../src/components/Markdown.tsx");
    expect(joinPath("collected/task/report", "images/fig1.png")).toBe(
      "collected/task/report/images/fig1.png",
    );
    expect(joinPath("a/b", "./../c.png")).toBe("a/c.png");
    expect(joinPath("", "../x")).toBeNull();
  });

  it("puts report/report.md first among Markdown outputs", async () => {
    const { reportCandidates } = await import("../src/lib/report.ts");
    const f = (path: string) => ({ path, bytes: 1, mtime: "" });
    const a = {
      files: [
        f("collected/task/INSTRUCTIONS.md"),
        f("collected/task/outputs/notes.md"),
        f("collected/task/report/report.md"),
        f("x.png"),
      ],
      truncated: false,
    };
    expect(reportCandidates(a)).toEqual([
      "collected/task/report/report.md",
      "collected/task/outputs/notes.md",
      "collected/task/INSTRUCTIONS.md",
    ]);
  });
});

describe("review kinds", () => {
  it("renders known kinds, falls back for unknown ones and says so", async () => {
    const { resolveKind, extraFields, showValue, KNOWN_KINDS } = await import(
      "../src/lib/review.ts"
    );
    const { REVIEW_KINDS } = await import("../../orbit/src/contracts/index.ts");
    expect([...KNOWN_KINDS]).toEqual([...REVIEW_KINDS]);
    expect(resolveKind({ kind: "markdown", path: "r.txt" })).toEqual({
      kind: "markdown",
      note: null,
    });
    expect(resolveKind({ kind: "notebook", fallback: "json", path: "a.ipynb" })).toEqual({
      kind: "json",
      note: 'unknown kind "notebook", shown as json',
    });
    expect(resolveKind({ kind: "plot3d", path: "fig.png" })).toEqual({
      kind: "image",
      note: 'unknown kind "plot3d", shown as image (file extension)',
    });
    expect(resolveKind({ kind: "weird", path: "out.bin" })).toEqual({
      kind: "text",
      note: 'unknown kind "weird", shown as text',
    });
    expect(resolveKind({ path: "results.csv" })).toEqual({ kind: "table", note: null });
    expect(resolveKind({ path: "episodes/trial/video.MP4" })).toEqual({
      kind: "video",
      note: null,
    });
    expect(extraFields({ a: 1, files: [], newField: { x: 1 } }, ["a", "files"])).toEqual([
      ["newField", { x: 1 }],
    ]);
    expect(showValue({ x: 1 })).toBe('{"x":1}');
    expect(showValue(null)).toBe("null");
  });
});

describe("folders", () => {
  it("builds the tree with parents and totals over subfolders", () => {
    const at = "2026-10-05T00:00:00Z";
    const t = folderTree([
      { path: "rcb/noskills", runs: 4, jobs: 1, active: 1, sizeBytes: 100, updatedAt: at },
      { path: "rcb/skills", runs: 2, jobs: 1, active: 0, sizeBytes: 50, updatedAt: at },
      { path: "tbs", runs: 1, jobs: 0, active: 0, sizeBytes: 5, updatedAt: at },
    ]);
    expect(t.map((n) => [n.path, n.depth, n.runs, n.sizeBytes])).toEqual([
      ["rcb", 0, 6, 150],
      ["rcb/noskills", 1, 4, 100],
      ["rcb/skills", 1, 2, 50],
      ["tbs", 0, 1, 5],
    ]);
    expect(t[0]?.active).toBe(1);
  });

  it("validates folder paths like the daemon", () => {
    expect(folderError("")).toBeNull();
    expect(folderError("rcb/noskills")).toBeNull();
    expect(folderError("rcb/")).not.toBeNull();
    expect(folderError("../x")).not.toBeNull();
  });
});
