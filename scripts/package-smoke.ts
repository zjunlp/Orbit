// Install the release tarball away from the checkout and exercise its public entrypoints.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "packages/orbit/package.json"), "utf8"));
const portable = JSON.parse(readFileSync(join(root, "plugin/plugin.json"), "utf8"));
const claude = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"));
assert.equal(portable.name, claude.name);
assert.equal(
  portable.version,
  claude.version,
  "Codex and Claude must receive the same plugin version",
);
const temp = mkdtempSync(join(tmpdir(), "orbit-package-"));
const env = {
  ...process.env,
  ORBIT_HOME: join(temp, "home"),
  ORBIT_DATA: join(temp, "data"),
  ORBIT_PORT: "",
};
const tarball = process.argv[2]
  ? resolve(process.argv[2])
  : join(temp, `zjunlp-orbit-${manifest.version}.tgz`);

function run(command: string, args: string[], cwd = temp, allowFailure = false): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

const cli = join(temp, "node_modules/.bin/orbit");
try {
  if (!process.argv[2])
    run("pnpm", ["--filter", "@zjunlp/orbit", "pack", "--pack-destination", temp], root);
  writeFileSync(join(temp, "package.json"), '{"private":true,"type":"module"}\n');
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  assert.equal(run(cli, ["--version"]).trim(), manifest.version);
  const pkg = join(temp, "node_modules/@zjunlp/orbit");
  for (const file of [
    "bench-adapters/humaneval/adapter.py",
    "bench-adapters/harbor-suites/adapter.mjs",
    "sdk/orbit_bench/__init__.py",
    "bench-adapters/embodied/benchmarks/behavior-1k/configure_behavior.py",
    ...[
      "legalbench",
      "lawbench",
      "healthbench",
      "longmemeval",
      "financebench",
      "agentdojo",
      "swebench",
      "appworld",
      "minif2f",
      "mmau",
    ].map((family) => `bench-adapters/${family}/adapter.py`),
  ])
    assert.ok(
      existsSync(join(pkg, "dist/bench-assets/examples", file)),
      `missing packaged benchmark asset: ${file}`,
    );
  assert.ok(existsSync(join(pkg, "LICENSE")));
  assert.ok(existsSync(join(pkg, "README.md")));
  const notices = readFileSync(join(pkg, "dist/web/THIRD_PARTY_LICENSES.md"), "utf8");
  const web = join(root, "packages/web");
  const webManifest = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
  for (const name of Object.keys(webManifest.dependencies)) {
    const dependency = join(web, "node_modules", name);
    const license = readFileSync(join(dependency, "LICENSE"), "utf8").trim();
    assert.ok(notices.includes(name), `missing attribution for ${name}`);
    assert.ok(notices.includes(license), `missing full license text for ${name}`);
  }
  const installed = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  assert.deepEqual(installed.pi.skills, ["./dist/plugin/skills"]);
  assert.ok(existsSync(join(pkg, installed.dsh.bundle.patch)));
  const dsh = await import(join(pkg, "dist/plugin/dsh.mjs"));
  assert.equal(typeof dsh.apply, "function");
  assert.deepEqual(dsh.inject, ["skills"]);
  assert.ok(
    !existsSync(join(temp, "node_modules/@deepseek-ai/dsh-skill-filesystem")),
    "dsh stays an optional host dependency",
  );
  for (const name of ["orbit", "orbit-bench", "orbit-evolve"]) {
    assert.equal(
      readFileSync(join(pkg, "dist/plugin/skills", name, "SKILL.md"), "utf8"),
      readFileSync(join(root, "plugin/skills", name, "SKILL.md"), "utf8"),
      `packaged ${name} must match the canonical skill`,
    );
  }
  assert.equal(
    readFileSync(
      join(pkg, "dist/plugin/skills/orbit-evolve/assets/minimal-bundle/AGENTS.md"),
      "utf8",
    ),
    readFileSync(join(root, "plugin/skills/orbit-evolve/assets/minimal-bundle/AGENTS.md"), "utf8"),
    "the evolver starter bundle must ship unchanged",
  );
  for (const target of Object.values(installed.exports) as { types: string; import: string }[]) {
    assert.ok(existsSync(join(pkg, target.types)), `missing types: ${target.types}`);
    assert.ok(existsSync(join(pkg, target.import)), `missing runtime: ${target.import}`);
  }
  run(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { RunSpec } from '@zjunlp/orbit/contracts';
    import { runDisplayName } from '@zjunlp/orbit/naming';
    import * as metrics from '@zjunlp/orbit/metrics';
    assert.equal(typeof RunSpec.parse, 'function');
    assert.equal(typeof runDisplayName, 'function');
    assert.ok(Object.keys(metrics).length > 0);
  `,
  ]);
  // A missing Docker/GPU prerequisite is legitimate on CI; the JSON response must still work.
  const report = JSON.parse(
    run("npm", ["exec", "--offline", "--", "orbit", "doctor", "--json"], temp, true),
  );
  assert.equal(typeof report.ok, "boolean");
  const resources = JSON.parse(run(cli, ["bench", "resources", "--json"]));
  assert.equal(resources.recipes.length, 62);
  assert.ok(
    resources.recipes.every(
      (recipe: { id: string; resources: unknown[] }) => recipe.id && recipe.resources.length,
    ),
  );
  assert.ok(report.checks.length > 0);
  console.log(
    `doctor: ${report.ok ? "passed" : "prerequisites missing"}; ${report.checks.length} real checks`,
  );
  const info = JSON.parse(readFileSync(join(env.ORBIT_HOME, "daemon.json"), "utf8"));
  const health = await fetch(`${info.url}/api/v1/health`, {
    headers: { Authorization: `Bearer ${info.token}` },
  });
  assert.equal(health.status, 200);
  const page = await fetch(info.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)];
  assert.ok(assets.length > 0, "bundled Web assets must be referenced");
  for (const asset of assets) assert.equal((await fetch(`${info.url}${asset[1]}`)).status, 200);
  console.log(
    "package smoke passed: installed CLI, npx, exports/types, daemon HTTP, Web, assets and licenses",
  );
} finally {
  if (existsSync(cli)) run(cli, ["daemon", "--stop"]);
  // Wait for the task-owned daemon to remove its endpoint before removing the private home.
  if (existsSync(join(env.ORBIT_HOME, "daemon.json"))) {
    for (let i = 0; i < 100 && existsSync(join(env.ORBIT_HOME, "daemon.json")); i++)
      await new Promise((done) => setTimeout(done, 100));
    assert.ok(
      !existsSync(join(env.ORBIT_HOME, "daemon.json")),
      "package smoke daemon did not stop",
    );
  }
  rmSync(temp, { recursive: true, force: true });
}
