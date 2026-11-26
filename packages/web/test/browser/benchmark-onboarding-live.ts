// Opt-in real daemon + built Web validation. No mocked HTTP, registration, Docker runs or models.
// After pnpm build: ORBIT_CHROMIUM_PATH=/path/to/chromium node packages/web/test/browser/benchmark-onboarding-live.ts
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { OrbitClient } from "../../../orbit/src/client/index.ts";
import { orbitPaths } from "../../../orbit/src/config/paths.ts";
import { type StartedDaemon, startDaemon } from "../../../orbit/src/daemon/server.ts";

const output = await mkdtemp(join(tmpdir(), "orbit-onboarding-live-"));
const paths = orbitPaths({ ORBIT_HOME: join(output, "home"), ORBIT_DATA: join(output, "data") });
let daemon: StartedDaemon | undefined;
let browser: Browser | undefined;
const errors: string[] = [];
try {
  // The default resource probe is real. Only this isolated daemon is stopped in finally.
  daemon = await startDaemon(paths, { port: 0 });
  const client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
  const code = await client.loginCode();
  browser = await chromium.launch({
    ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${daemon.url}/login?code=${encodeURIComponent(code.code)}&next=${encodeURIComponent("/benchmarks?mode=add")}`,
  );
  await page.getByRole("heading", { name: "Add your own benchmark", exact: true }).waitFor();
  for (const template of ["adapter", "manifest"] as const) {
    const directory = join(output, `${template}-tutorial`);
    await page.getByLabel("Template", { exact: true }).selectOption(template);
    await page.getByLabel("Benchmark name", { exact: true }).fill(`live-${template}`);
    await page.getByLabel("New directory on the daemon machine", { exact: true }).fill(directory);
    await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
    const created = page.getByRole("region", { name: "Tutorial created", exact: true });
    await created.waitFor();
    assert.ok((await created.innerText()).includes(directory));
    const definition = JSON.parse(await readFile(join(directory, "benchmark.json"), "utf8"));
    assert.equal(definition.name, `live-${template}`);
    assert.equal(definition.path, directory);
    assert.equal(
      definition.adapter,
      template === "adapter" ? join(directory, "adapter.py") : "manifest",
    );
    for (const file of [
      "README.md",
      "resources.json",
      "runtime.py",
      "grader.py",
      template === "adapter" ? "adapter.py" : "orbit-bench.yaml",
    ])
      await access(join(directory, file));
    const commands = await created.locator("code").allTextContents();
    assert.ok(commands.some((text) => text.startsWith("orbit bench add-file ")));
    assert.ok(commands.some((text) => text.startsWith("orbit bench coverage ")));
    assert.ok(commands.some((text) => text.startsWith("orbit bench calibrate ")));
    assert.equal(
      await created.getByRole("button", { name: "Copy command", exact: true }).count(),
      3,
    );
    await page.screenshot({ path: join(output, `${template}-created.png`), fullPage: true });
    await page.getByRole("button", { name: "Create another tutorial", exact: true }).click();
    const original = await readFile(join(directory, "benchmark.json"), "utf8");
    await page.getByLabel("New directory on the daemon machine", { exact: true }).fill(directory);
    await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
    assert.equal(await readFile(join(directory, "benchmark.json"), "utf8"), original);
    await page.screenshot({ path: join(output, `${template}-duplicate.png`), fullPage: true });
  }
  const families = (await client.benchCatalog()).supported.slice(0, 2);
  assert.equal(families.length, 2);
  const comparisonQuery = new URLSearchParams({
    view: "compare",
    compare: families.map((family) => family.id).join(","),
  });
  await page.goto(`${daemon.url}/benchmarks?${comparisonQuery}`);
  const comparison = page.getByRole("region", { name: "Benchmark comparison table", exact: true });
  await comparison.waitFor();
  for (const family of families) {
    await comparison.getByRole("columnheader", { name: family.name, exact: true }).waitFor();
    assert.ok((await comparison.innerText()).includes(family.description));
    const profile = family.taxonomyGroups[0];
    assert.ok(profile);
    if (family.taxonomyGroups.length > 1) {
      const selector = comparison.getByRole("combobox", {
        name: `Protocol profile for ${family.name}`,
        exact: true,
      });
      assert.equal(await selector.inputValue(), "0");
      assert.ok((await selector.innerText()).includes(profile.label));
    } else {
      assert.ok((await comparison.innerText()).includes(profile.label));
    }
  }
  await page.screenshot({ path: join(output, "real-family-comparison.png"), fullPage: true });
  assert.deepEqual(await client.benchmarks(), []);
  assert.deepEqual(await client.benchJobs(), []);
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "validation.json"),
    JSON.stringify(
      {
        result: "passed",
        backend: "real daemon and resource probe; built Web; no HTTP mocks",
        templates: ["adapter", "manifest"],
        realCatalogComparison:
          "two real families; names, descriptions and protocol profiles verified",
        duplicateDirectory: "rejected; original definition unchanged",
        registrations: 0,
        benchJobs: 0,
        runs: 0,
        dockerTasks: "not_run",
        modelChecks: "not_run",
      },
      null,
      2,
    ),
  );
  console.log(`Real Web onboarding passed; retained validation artifacts: ${output}`);
} catch (error) {
  await writeFile(join(output, "failure.txt"), String(error));
  console.error(`Validation artifacts retained: ${output}`);
  throw error;
} finally {
  try {
    await browser?.close();
  } finally {
    await daemon?.stop();
  }
}
