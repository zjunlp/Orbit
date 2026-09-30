import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = "src/web/src/api/review.generated.ts";
function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `${command} failed`);
  return result.stdout;
}
const schema = run("uv", [
  "run",
  "--locked",
  "python",
  "scripts/dev/export_review_schema.py",
]);
const types = await compile(JSON.parse(schema), "ReviewResponse", {
  bannerComment:
    "/* Generated from runs/review_api.py. Run pnpm contracts; do not edit. */",
  additionalProperties: false,
});
const formatted = run(
  "pnpm",
  ["exec", "biome", "format", `--stdin-file-path=${target}`],
  types,
);
if (process.argv.includes("--check")) {
  if (readFileSync(root + target, "utf8") !== formatted) {
    throw new Error(
      "Review API types drifted; run pnpm contracts and include the generated file.",
    );
  }
} else {
  writeFileSync(root + target, formatted);
}
