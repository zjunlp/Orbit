// Synthetic HTTP compatibility interactions; no real Agent, credentials, or jobs are run.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Route } from "playwright-core";

const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4197";
const output = resolve(
  process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-evaluation-compatibility`,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const registration = (name: string) => ({
  name,
  adapter: "/synthetic/adapter.py",
  path: "/synthetic",
  config: {},
  env: {},
  passEnv: [],
  createdAt: "2026-11-26",
  updatedAt: "2026-11-26",
});
const capabilities = {
  methods: ["empty", "oracle", "external", "cli"],
  requires: ["mcp"],
  conditions: {},
  scoreKind: "binary",
  rescore: "evidence",
};
const source = {
  id: "synthetic-source",
  spec: {
    benchmark: "alpha",
    tasks: ["one"],
    methods: [{ name: "copied", agent: "custom", auth: "wrong-kind" }],
    seeds: 1,
    options: {},
    lineage: {},
  },
  revisions: {},
  capabilities,
  source: null,
  resources: null,
  folder: "",
  state: "done",
  metrics: [],
  createdAt: "2026-11-26",
  endedAt: "2026-11-26",
};
let state = "blocked";
let marker = true;
let unavailable = false;
let tasksUnavailable = false;
let registryUnavailable = false;
let holdAlpha = false;
let held: Route | undefined;
let checks = 0;
let posts = 0;
const response = (benchmark: string) => ({
  agents: ["custom"],
  rows: [
    {
      benchmark,
      cells: {
        custom: {
          state: benchmark === "beta" ? "allowed" : state,
          reason: state === "blocked" ? "Synthetic MCP wiring is missing" : undefined,
          valid: 4,
          trials: 5,
        },
      },
    },
  ],
  ...(marker ? { checked: { benchmark, at: "2026-11-26T00:00:00Z" } } : {}),
});
await context.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path.endsWith("/stream"))
    return route.fulfill({ contentType: "text/event-stream", body: ": synthetic\n\n" });
  if (path.endsWith("/bench/compatibility")) {
    checks++;
    const benchmark = url.searchParams.get("benchmark");
    assert(benchmark);
    if (holdAlpha && benchmark === "alpha") {
      held = route;
      return;
    }
    if (unavailable)
      return route.fulfill({ status: 503, json: { error: "Synthetic listing unavailable" } });
    return route.fulfill({ json: response(benchmark) });
  }
  if (path.endsWith("/bench/jobs") && route.request().method() === "POST") {
    posts++;
    return route.fulfill({
      status: 400,
      json: { error: "Synthetic submission received; no job was created" },
    });
  }
  let json: unknown = {};
  if (path.endsWith("/benchmarks"))
    json = { benchmarks: [registration("alpha"), registration("beta")] };
  else if (path.endsWith("/tasks")) {
    if (tasksUnavailable)
      return route.fulfill({ status: 503, json: { error: "Synthetic task listing failure" } });
    json = {
      tasks: [{ id: "one", title: "Synthetic task", supported: true, reason: null, tags: {} }],
      metrics: [],
      capabilities,
    };
  } else if (path.endsWith("/agents")) {
    if (registryUnavailable)
      return route.fulfill({ status: 503, json: { error: "Synthetic registry unavailable" } });
    json = { agents: [{ definition: { name: "custom", auth: { kinds: ["api-key"] } } }] };
  } else if (path.endsWith("/auth"))
    json = {
      profiles: [
        { name: "good", harness: "custom", kind: "api-key" },
        { name: "wrong-kind", harness: "custom", kind: "login" },
        { name: "other", harness: "other", kind: "api-key" },
      ],
    };
  else if (path.endsWith("/bench/jobs")) json = { jobs: [source] };
  else if (path.endsWith("/bench/jobs/synthetic-source")) json = { job: source };
  await route.fulfill({ json });
});
async function waitHeld(): Promise<Route> {
  while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
  return held;
}
const continueButton = () => page.getByRole("button", { name: "Continue", exact: true });
const refresh = () =>
  page.getByRole("button", { name: "Refresh configuration checks", exact: true });
const feedback = () => page.getByRole("region", { name: /^Compatibility for/ }).first();
async function configuration() {
  await continueButton().click();
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("custom");
  await page.getByRole("combobox", { name: "Auth profile", exact: true }).selectOption("good");
}
try {
  await page.goto(`${base}/bench/new?benchmark=alpha`);
  await configuration();
  await feedback()
    .getByText(/Cannot submit.*Synthetic MCP/)
    .waitFor();
  assert.equal(await continueButton().isDisabled(), true);
  assert.equal(
    await page
      .getByRole("combobox", { name: "Auth profile" })
      .locator("option[value=wrong-kind]")
      .count(),
    0,
  );
  const beforeEdits = checks;
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("kept-draft");
  await page.getByRole("textbox", { name: "Model", exact: true }).fill("synthetic-model");
  assert.equal(checks, beforeEdits);
  await page.setViewportSize({ width: 390, height: 844 });
  await feedback().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "narrow-blocked.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  state = "allowed";
  await refresh().focus();
  await page.keyboard.press("Enter");
  await feedback()
    .getByText(/Declared configuration checks allow/)
    .waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
    "kept-draft",
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Model", exact: true }).inputValue(),
    "synthetic-model",
  );
  tasksUnavailable = true;
  await refresh().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not reload environment tasks: Synthetic task listing failure" })
    .waitFor();
  await feedback()
    .getByText(/Declared configuration checks allow/)
    .waitFor();
  assert.equal(await continueButton().isDisabled(), true);
  tasksUnavailable = false;
  await refresh().click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Continue" && !button.disabled,
    ),
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
    "kept-draft",
  );
  assert.equal(
    await page.getByRole("textbox", { name: "Model", exact: true }).inputValue(),
    "synthetic-model",
  );
  await continueButton().click();
  const start = page.getByRole("button", { name: "Start evaluation", exact: true });
  await start.waitFor();
  tasksUnavailable = true;
  await refresh().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not reload environment tasks: Synthetic task listing failure" })
    .waitFor();
  await feedback()
    .getByText(/Declared configuration checks allow/)
    .waitFor();
  assert.equal(await start.isDisabled(), true);
  tasksUnavailable = false;
  await refresh().click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Start evaluation" && !button.disabled,
    ),
  );
  assert.match(await page.locator(".bench-review-methods").innerText(), /kept-draft/);
  state = "blocked";
  await refresh().click();
  await feedback()
    .getByText(/Cannot submit.*Synthetic MCP/)
    .waitFor();
  assert.equal(await start.isDisabled(), true);
  assert.equal(posts, 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await feedback().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "desktop-review-blocked.png"), fullPage: true });
  holdAlpha = true;
  held = undefined;
  await refresh().click();
  await waitHeld();
  await feedback()
    .getByText(/Checking current Agent compatibility/)
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Start evaluation" && !button.disabled,
    ),
  );
  assert.equal(await start.isEnabled(), true);
  assert.doesNotMatch(await feedback().innerText(), /Cannot submit/);
  holdAlpha = false;
  await (await waitHeld()).fulfill({ json: response("alpha") });
  await feedback()
    .getByText(/Cannot submit.*Synthetic MCP/)
    .waitFor();
  assert.equal(await start.isDisabled(), true);
  unavailable = true;
  await refresh().click();
  await feedback()
    .getByText(/Compatibility unavailable/)
    .waitFor();
  assert.equal(await start.isEnabled(), true);
  await start.click();
  await page.getByRole("alert").filter({ hasText: "Synthetic submission received" }).waitFor();
  assert.equal(posts, 1);
  unavailable = false;
  state = "unknown";
  await refresh().click();
  await feedback()
    .getByText(/Compatibility unknown/)
    .waitFor();
  assert.equal(await start.isEnabled(), true);
  state = "needs-auth";
  await refresh().click();
  await feedback()
    .getByText(/no compatible auth profile/)
    .waitFor();
  assert.equal(await start.isEnabled(), true);
  marker = false;
  state = "blocked";
  await refresh().click();
  await feedback()
    .getByText(/Compatibility unknown/)
    .waitFor();
  assert.equal(await start.isEnabled(), true);
  marker = true;
  state = "allowed";
  await page.goto(`${base}/bench/new?from=synthetic-source`);
  await continueButton().click();
  await feedback()
    .getByText(/does not accept login/)
    .waitFor();
  assert.equal(await continueButton().isDisabled(), true);
  await page.getByRole("combobox", { name: "Auth profile", exact: true }).selectOption("good");
  assert.equal(await continueButton().isEnabled(), true);
  await page.getByText("Import configurations", { exact: true }).first().click();
  await page
    .getByRole("textbox", { name: "Configurations JSON", exact: true })
    .fill(JSON.stringify([{ name: "imported", agent: "custom", auth: "wrong-kind" }]));
  await page.getByRole("button", { name: "Import configurations", exact: true }).click();
  await feedback()
    .getByText(/does not accept login/)
    .waitFor();
  assert.equal(await continueButton().isDisabled(), true);
  await page
    .getByRole("combobox", { name: "Copy configurations from an evaluation", exact: true })
    .selectOption("synthetic-source");
  assert.equal(
    await page.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
    "copied",
  );
  await feedback()
    .getByText(/does not accept login/)
    .waitFor();
  await page.getByRole("combobox", { name: "Auth profile", exact: true }).selectOption("good");
  registryUnavailable = true;
  await refresh().click();
  await feedback()
    .getByText(/Agent registry unavailable/)
    .waitFor();
  assert.equal(await continueButton().isEnabled(), true);
  assert.match(
    await page
      .getByRole("combobox", { name: "Type", exact: true })
      .locator("option:checked")
      .innerText(),
    /not verified/,
  );
  registryUnavailable = false;
  await refresh().click();
  await feedback()
    .getByText(/Declared configuration checks allow/)
    .waitFor();
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("oracle");
  assert.equal(await continueButton().isEnabled(), true);
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption("external");
  await page
    .getByRole("textbox", { name: "Installed policy entrypoint", exact: true })
    .fill("synthetic:policy");
  await continueButton().click();
  await start.waitFor();
  registryUnavailable = true;
  await refresh().click();
  await feedback()
    .getByText(/External policies/)
    .waitFor();
  assert.equal(await start.isEnabled(), true);
  registryUnavailable = false;
  holdAlpha = true;
  held = undefined;
  await page.goto(`${base}/bench/new?benchmark=alpha`);
  await waitHeld();
  await page
    .getByRole("combobox", { name: "Registered environment", exact: true })
    .selectOption("beta");
  await configuration();
  await feedback()
    .getByText(/Declared configuration checks allow/)
    .waitFor();
  holdAlpha = false;
  state = "blocked";
  await (await waitHeld()).fulfill({ json: response("alpha") }).catch(() => {});
  assert.equal(await continueButton().isEnabled(), true);
  assert.doesNotMatch(await feedback().innerText(), /Cannot submit/);
  assert.deepEqual(errors, []);
  console.log(
    "passed: synthetic HTTP fresh blocked despite history, selected auth kinds, unknown/error/legacy handling, copy/import, special methods, refresh preservation, review blocking, late benchmark response and narrow keyboard layout",
  );
} finally {
  await browser.close();
}
