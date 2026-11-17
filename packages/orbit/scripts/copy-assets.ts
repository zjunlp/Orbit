// Package the Web UI and the canonical skills alongside the compiled entrypoints.
import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsdown";

const pkg = join(import.meta.dirname, "..");
const from = join(pkg, "../web/dist");
const to = join(pkg, "dist/web");
if (!existsSync(join(from, "index.html"))) {
  console.error("copy-assets: packages/web/dist is missing; run `pnpm build` at the repo root");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
cpSync(join(pkg, "../../LICENSE"), join(pkg, "LICENSE"));
const plugin = join(pkg, "../../plugin");
cpSync(join(plugin, "skills"), join(pkg, "dist/plugin/skills"), { recursive: true });
cpSync(join(plugin, "cordis.patch.yml"), join(pkg, "dist/plugin/cordis.patch.yml"));
const examples = join(pkg, "../../examples");
await build({
  config: false,
  entry: {
    "bench-assets/examples/bench-adapters/harbor-suites/adapter": join(
      examples,
      "bench-adapters/harbor-suites/adapter.ts",
    ),
  },
  outDir: join(pkg, "dist"),
  format: "esm",
  platform: "node",
  target: "node24",
  dts: false,
  clean: false,
});
for (const directory of ["bench-adapters", "sdk", "tools", "bench-manifests"]) {
  if (!existsSync(join(examples, directory))) continue;
  cpSync(join(examples, directory), join(pkg, "dist/bench-assets/examples", directory), {
    recursive: true,
    filter: (path) =>
      !path.includes("__pycache__") && !path.endsWith(".pyc") && !path.includes("/node_modules/"),
  });
}
chmodSync(join(pkg, "dist/bench-assets/examples/bench-adapters/harbor-suites/adapter.mjs"), 0o755);
console.log("copy-assets: Web, plugins and benchmark preparation assets ready");
