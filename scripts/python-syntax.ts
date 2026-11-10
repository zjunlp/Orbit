// Syntax-checks every Python file in the repository without importing it or writing bytecode.
// The bench adapter tests already require python3, so this adds no new prerequisite to `verify`.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["examples", "scripts"];
const SKIP = new Set(["__pycache__", "node_modules", ".git", "dist"]);
const CHECK = `
import ast, sys
bad = []
for path in sys.argv[1:]:
    try:
        with open(path, encoding="utf-8") as fh:
            ast.parse(fh.read(), filename=path)
    except SyntaxError as e:
        bad.append(f"{path}:{e.lineno}: {e.msg}")
print("\\n".join(bad))
sys.exit(1 if bad else 0)
`;

function pythonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pythonFiles(path));
    else if (entry.name.endsWith(".py")) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((root) => pythonFiles(root));
if (files.length === 0) {
  console.error("python-syntax: no Python files found");
  process.exit(1);
}

// `ast.parse` reads the source only: no imports run and no .pyc files are written.
const result = spawnSync("python3", ["-B", "-c", CHECK, ...files], { encoding: "utf8" });
if (result.error) {
  console.error(`python-syntax: ${result.error.message}`);
  process.exit(1);
}
const problems = result.stdout.trim();
if (result.status !== 0 || problems) {
  console.error(problems || `python-syntax: python3 exited ${result.status}`);
  process.exit(1);
}
console.log(`python-syntax: ${files.length} files parsed`);
