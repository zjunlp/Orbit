import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Navigation docs. Research snapshots cite external checkouts by path and are excluded. */
const ROOT_DOCS = ["README.md", "README.zh-CN.md", "AGENTS.md", "THIRD_PARTY_NOTICES.md"];

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "research") continue;
      out.push(...markdownFiles(path));
    } else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const files = [
  ...ROOT_DOCS.map((f) => join(repoRoot, f)),
  ...markdownFiles(join(repoRoot, "docs")),
];

/** Relative markdown links that a reader is expected to follow. */
function brokenLinks(file: string): string[] {
  const base = dirname(file);
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = (m[1] ?? "").trim();
      if (!target || /^(https?:|mailto:|#|\/)/.test(target)) continue;
      const path = target.split("#")[0] as string;
      // Source citations name a file and a line (`service.ts:1339`); they are references, not links.
      if (!path || /:\d+$/.test(path)) continue;
      if (!existsSync(normalize(join(base, path))))
        out.push(`${file.slice(repoRoot.length)} -> ${target}`);
    }
  }
  return out;
}

it("keeps every relative markdown link resolvable", () => {
  expect(files.length).toBeGreaterThan(50);
  expect(files.flatMap(brokenLinks)).toEqual([]);
});
