// Opt-in real daemon + built Web validation; no HTTP mocks, Docker jobs or models.
// After pnpm build: ORBIT_CHROMIUM_PATH=/path/to/chromium node packages/web/test/browser/benchmark-registration-live.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { OrbitClient } from "../../../orbit/src/client/index.ts";
import { orbitPaths } from "../../../orbit/src/config/paths.ts";
import { type StartedDaemon, startDaemon } from "../../../orbit/src/daemon/server.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../../../orbit/src/bin.ts", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "orbit-registration-live-"));
let browser: Browser | undefined;
let daemon: StartedDaemon | undefined;
const errors: string[] = [];
try {
  browser = await chromium.launch({
    ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
    args: ["--no-sandbox"],
  });
  for (const template of ["adapter", "manifest"] as const) {
    const scenario = join(output, template);
    await mkdir(scenario);
    const paths = orbitPaths({
      ORBIT_HOME: join(scenario, "home"),
      ORBIT_DATA: join(scenario, "data"),
    });
    daemon = await startDaemon(paths, { port: 0, self: [process.execPath, cli] });
    const client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
    const created = await client.benchInit({
      name: `live-${template}`,
      directory: join(scenario, "tutorial"),
      template,
    });
    const definition =
      created.definition ??
      JSON.parse(await readFile(join(created.directory, "benchmark.json"), "utf8"));
    const cliCheck = await exec(
      process.execPath,
      [cli, "bench", "add-file", join(created.directory, "benchmark.json"), "--check", "--json"],
      {
        env: { ...process.env, ORBIT_HOME: paths.home, ORBIT_DATA: paths.data },
      },
    );
    const cliReview = JSON.parse(cliCheck.stdout);
    assert.equal(cliReview.definition.name, definition.name);
    assert.equal(cliReview.coverage.supported, 1);
    assert.deepEqual(await client.benchmarks(), []);
    const login = await client.loginCode();
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page: Page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${daemon.url}/login?code=${encodeURIComponent(login.code)}&next=${encodeURIComponent("/benchmarks?mode=add")}`,
    );
    // Keep selectors tied to public form labels, not implementation-specific CSS.
    await page.getByRole("button", { name: "Import definition", exact: true }).click();
    const source = page.getByLabel("Definition JSON", { exact: true });
    if (template === "adapter") await source.fill(JSON.stringify(definition, null, 2));
    else
      await page
        .getByLabel("Definition JSON file", { exact: true })
        .setInputFiles(join(created.directory, "benchmark.json"));
    const checked = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/benchmarks/check"),
    );
    await page.getByRole("button", { name: "Check definition", exact: true }).click();
    const response = await checked;
    assert.equal(response.status(), 200);
    const review = await response.json();
    assert.equal(review.existing, false);
    assert.equal(review.coverage.total, 1);
    assert.equal(review.coverage.supported, 1);
    assert.deepEqual(await client.benchmarks(), []);
    assert.deepEqual(await client.benchJobs(), []);
    assert.deepEqual(await client.list(), []);
    await page.screenshot({ path: join(output, `${template}-checked.png`), fullPage: true });
    const registered = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith("/benchmarks") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Register local setup", exact: true }).click();
    const savedResponse = await registered;
    assert.equal(new URL(savedResponse.url()).searchParams.get("createOnly"), "true");
    assert.equal(savedResponse.status(), 201);
    const saved = await savedResponse.json();
    await page.getByRole("region", { name: "Benchmark registered", exact: true }).waitFor();
    assert.equal(saved.name, definition.name);
    assert.equal(saved.path, definition.path);
    assert.equal(saved.adapter, definition.adapter);
    const registrations = await client.benchmarks();
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0], saved);
    await page.screenshot({ path: join(output, `${template}-registered.png`), fullPage: true });
    // An existing-name check remains read-only; a different path cannot replace the registration.
    const conflict = await client.benchInit({
      name: definition.name,
      directory: join(scenario, "conflict"),
      template,
    });
    const conflictDefinition =
      conflict.definition ??
      JSON.parse(await readFile(join(conflict.directory, "benchmark.json"), "utf8"));
    await page.goto(`${daemon.url}/benchmarks?mode=add`);
    await page.getByRole("button", { name: "Import definition", exact: true }).click();
    await page
      .getByLabel("Definition JSON", { exact: true })
      .fill(JSON.stringify(conflictDefinition));
    await page.getByRole("button", { name: "Check definition", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Register local setup", exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: join(output, `${template}-existing.png`), fullPage: true });
    assert.equal((await client.benchmarkCheck(conflictDefinition)).existing, true);
    await assert.rejects(
      () => client.benchmarkPut(conflictDefinition, { createOnly: true }),
      /already registered/,
    );
    assert.deepEqual(await client.benchmarks(), registrations);
    assert.deepEqual(await client.benchJobs(), []);
    assert.deepEqual(await client.list(), []);
    await context.close();
    await daemon.stop();
    daemon = undefined;
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "validation.json"),
    JSON.stringify(
      {
        result: "passed",
        backend: "real daemon/resource probe and built Web; no HTTP mocks",
        templates: ["adapter", "manifest"],
        check: "real CLI and browser check; registry/jobs/runs empty",
        registration: "one matching definition per isolated scenario; explicit create-only",
        conflict: "existing reported and different-path replacement rejected",
        dockerTasks: "not_run",
        modelChecks: "not_run",
      },
      null,
      2,
    ),
  );
  console.log(`Real Web registration passed; retained validation artifacts: ${output}`);
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
