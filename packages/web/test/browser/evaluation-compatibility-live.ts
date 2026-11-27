// Opt-in real HTTP/checker + built Web validation with explicit synthetic Agent/listing fixtures.
// No real credentials, Agent execution, Docker jobs or model calls.
// After pnpm build: ORBIT_CHROMIUM_PATH=/path/to/chromium node packages/web/test/browser/evaluation-compatibility-live.ts
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { OrbitClient } from "../../../orbit/src/client/index.ts";
import { orbitPaths } from "../../../orbit/src/config/paths.ts";
import { type StartedDaemon, startDaemon } from "../../../orbit/src/daemon/server.ts";

const output = await mkdtemp(join(tmpdir(), "orbit-compatibility-live-"));
const paths = orbitPaths({ ORBIT_HOME: join(output, "home"), ORBIT_DATA: join(output, "data") });
const cli = fileURLToPath(new URL("../../../orbit/src/bin.ts", import.meta.url));
const fixture = join(output, "synthetic-listing");
const name = "synthetic-compatibility-agent";
let daemon: StartedDaemon | undefined;
let browser: Browser | undefined;
let diagnosticPage: Page | undefined;
const errors: string[] = [];
let posts = 0;
try {
  await mkdir(fixture);
  const listing = join(fixture, "listing.json");
  const adapter = join(fixture, "adapter.py");
  await writeFile(
    adapter,
    `#!/usr/bin/env python3
# Explicit synthetic listing fixture; no solve or verify implementation.
import json
from pathlib import Path
import sys
req = json.load(sys.stdin)
assert req["op"] == "tasks"
print((Path(__file__).parent / "listing.json").read_text())
`,
  );
  await chmod(adapter, 0o700);
  async function setListing(requires: string[] | null) {
    await writeFile(
      listing,
      JSON.stringify({
        tasks: [{ id: "synthetic", title: "Synthetic listing only", supported: true, reason: "" }],
        ...(requires === null
          ? {}
          : {
              capabilities: {
                methods: ["cli", "empty"],
                requires,
                conditions: { scope: "Explicit synthetic compatibility fixture" },
                scoreKind: "binary",
                rescore: "none",
              },
            }),
      }),
    );
  }
  await setListing(["mcp"]);
  daemon = await startDaemon(paths, { port: 0, self: [process.execPath, cli] });
  const client = new OrbitClient({ url: daemon.url, token: daemon.token, pid: process.pid });
  await client.agentPut({
    name,
    description: "Explicit synthetic compatibility fixture; never executed",
    install: { kind: "image", binary: "synthetic-unused" },
    command: { run: ["synthetic-unused", "{instruction}"], mcp: { kind: "none" } },
    auth: { kinds: ["api-key"] },
    capabilities: { oneShot: true, mcp: false },
  });
  // Placeholder profile exists only in this isolated state; no network/auth test is performed.
  await client.authPut({
    name: "synthetic-placeholder",
    harness: name,
    kind: "api-key",
    secret: "synthetic-not-a-real-credential",
  });
  await client.benchmarkPut(
    { name: "synthetic-environment", path: fixture, adapter, config: {}, env: {}, passEnv: [] },
    { createOnly: true },
  );
  const before = await client.benchmarks();
  const cell = async () => {
    const result = await client.benchCompatibility("synthetic-environment");
    assert.equal(result.checked?.benchmark, "synthetic-environment");
    assert.ok(result.checked?.at);
    assert.equal(result.rows.length, 1);
    return result.rows[0]?.cells[name];
  };
  assert.equal((await cell())?.state, "blocked");
  // Warm the existing catalog, then mutate the listing. Targeted checks must not reuse it.
  await client.benchCatalog();
  await setListing([]);
  assert.equal((await cell())?.state, "allowed");
  await setListing(["mcp"]);
  const login = await client.loginCode();
  browser = await chromium.launch({
    ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
    args: ["--no-sandbox"],
  });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page: Page = await context.newPage();
  diagnosticPage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/bench/jobs"))
      posts++;
  });
  await page.goto(
    `${daemon.url}/login?code=${encodeURIComponent(login.code)}&next=${encodeURIComponent("/bench/new?benchmark=synthetic-environment")}`,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption(name);
  await page
    .getByRole("combobox", { name: "Auth profile", exact: true })
    .selectOption("synthetic-placeholder");
  const feedback = page.getByRole("region", { name: /^Compatibility for / }).first();
  await feedback.getByText(/requires MCP tool wiring/).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({ path: join(output, "blocked.png"), fullPage: true });
  await setListing([]);
  await page.getByRole("button", { name: "Refresh configuration checks", exact: true }).click();
  await feedback.getByText(/Declared configuration checks allow/).waitFor();
  assert.equal((await cell())?.state, "allowed");
  assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isEnabled(), true);
  await page.screenshot({ path: join(output, "allowed-admission.png"), fullPage: true });
  await setListing(null);
  assert.equal((await cell())?.state, "unknown");
  await page.getByRole("button", { name: "Refresh configuration checks", exact: true }).click();
  await feedback.getByText(/Compatibility unknown/).waitFor();
  await writeFile(listing, "invalid JSON");
  await assert.rejects(() => client.benchCompatibility("synthetic-environment"));
  await page.getByRole("button", { name: "Refresh configuration checks", exact: true }).click();
  await feedback.getByText(/Compatibility unavailable/).waitFor();
  await page.screenshot({ path: join(output, "unavailable.png"), fullPage: true });
  assert.equal(posts, 0);
  assert.deepEqual(await client.benchmarks(), before);
  assert.deepEqual(await client.benchJobs(), []);
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "validation.json"),
    JSON.stringify(
      {
        result: "passed",
        backend:
          "real daemon/resource probe, HTTP, task enumeration and admission checker; built Web",
        fixtures: "explicit synthetic listing, no-MCP Agent and placeholder auth; never executed",
        fresh: "blocked to allowed after editing listing, independent of catalog",
        unknownAndUnavailable: "distinct from allowed",
        registrations: "unchanged",
        jobs: 0,
        runs: 0,
        submitPosts: posts,
        dockerTasks: "not_run",
        modelChecks: "not_run",
      },
      null,
      2,
    ),
  );
  console.log(`Evaluation compatibility passed; retained artifacts: ${output}`);
} catch (error) {
  if (diagnosticPage && !diagnosticPage.isClosed()) {
    await diagnosticPage
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(output, "failure-body.txt"),
      await diagnosticPage.locator("body").innerText(),
    ).catch(() => {});
  }
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
