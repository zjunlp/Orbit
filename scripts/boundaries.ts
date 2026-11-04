// Enforces the module dependency table in docs/design.md §3.
// Usage: node scripts/boundaries.ts [srcDir [webSrcDir]]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const BASE = ["contracts", "lib"];
const CORE = [...BASE, "config", "store"];
const DOMAIN = ["resources", "auth", "images", "workspace", "executor", "records", "notify"];
const DOMAIN_ALL = [...DOMAIN, "harness", "sessions"];

/** module -> modules it may import (itself is always allowed). */
export const RULES: Record<string, string[]> = {
  contracts: [],
  lib: [],
  config: BASE,
  store: BASE,
  ...Object.fromEntries(DOMAIN.map((m) => [m, CORE])),
  harness: [...CORE, "auth"],
  sessions: [...CORE, "records", "harness"],
  runs: [...CORE, ...DOMAIN_ALL],
  bench: [...CORE, ...DOMAIN_ALL, "runs"],
  cluster: [...CORE, "resources", "workspace", "records", "runs"],
  feishu: [...CORE, "notify"],
  daemon: [...CORE, ...DOMAIN_ALL, "runs", "bench", "cluster", "feishu"],
  client: [...BASE, "config"],
  cli: [...BASE, "config", "client"],
  mcp: [...BASE, "config", "client"],
};

/** Files directly under src/ are composition roots and may import any module. */
const ROOT = "<root>";

export interface Violation {
  file: string;
  line: number;
  message: string;
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function moduleOf(srcDir: string, file: string): string {
  const rel = relative(srcDir, file).split(sep);
  return rel.length === 1 ? ROOT : (rel[0] ?? ROOT);
}

export function checkFile(srcDir: string, file: string, text: string): Violation[] {
  const from = moduleOf(srcDir, file);
  const out: Violation[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec?.startsWith(".")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const target = resolve(dirname(file), spec);
    const rel = relative(srcDir, target);
    if (rel.startsWith("..")) {
      out.push({ file, line, message: `imports outside src: ${spec}` });
      continue;
    }
    const to = moduleOf(srcDir, target);
    if (to === ROOT) {
      out.push({ file, line, message: `modules must not import composition roots: ${spec}` });
      continue;
    }
    if (from === ROOT || from === to) continue;
    const allowed = RULES[from];
    if (!allowed) {
      out.push({
        file,
        line,
        message: `unknown module "${from}"; add it to scripts/boundaries.ts and docs/design.md`,
      });
    } else if (!(to in RULES)) {
      out.push({ file, line, message: `unknown module "${to}"` });
    } else if (!allowed.includes(to)) {
      out.push({ file, line, message: `${from} must not depend on ${to} (${spec})` });
    }
  }
  return out;
}

const PKG_IMPORT_RE =
  /(?:^|[\s;])(import|export)(\s+type)?\s[^;]*?from\s+["'](@zjunlp\/orbit[^"']*)["']/g;

/**
 * The Web bundle may use the daemon's contracts as types only (no zod, no Node code), plus the
 * dependency-free run naming, bench metric and category rules at runtime.
 */
export function checkWebFile(srcDir: string, file: string, text: string): Violation[] {
  const out: Violation[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec?.startsWith(".")) continue;
    if (relative(srcDir, resolve(dirname(file), spec)).startsWith("..")) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ file, line, message: `web imports outside its src: ${spec}` });
    }
  }
  for (const m of text.matchAll(PKG_IMPORT_RE)) {
    const line = text.slice(0, m.index).split("\n").length;
    if (
      ["@zjunlp/orbit/naming", "@zjunlp/orbit/metrics", "@zjunlp/orbit/categories"].includes(
        m[3] ?? "",
      )
    )
      continue;
    if (m[3] !== "@zjunlp/orbit/contracts")
      out.push({
        file,
        line,
        message: `web may only import @zjunlp/orbit/contracts (types), /naming, /metrics or /categories: ${m[3]}`,
      });
    else if (!m[2])
      out.push({ file, line, message: "web must import contracts with `import type`" });
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

export function checkDir(srcDir: string, check = checkFile): Violation[] {
  return walk(srcDir).flatMap((f) => check(srcDir, f, readFileSync(f, "utf8")));
}

if (import.meta.main) {
  const srcDir = resolve(process.argv[2] ?? "packages/orbit/src");
  const webDir = resolve(process.argv[3] ?? "packages/web/src");
  const violations = [...checkDir(srcDir), ...checkDir(webDir, checkWebFile)];
  for (const v of violations)
    console.error(`${relative(process.cwd(), v.file)}:${v.line} ${v.message}`);
  if (violations.length > 0) process.exit(1);
  console.log(
    `boundaries ok (${relative(process.cwd(), srcDir)}, ${relative(process.cwd(), webDir)})`,
  );
}
