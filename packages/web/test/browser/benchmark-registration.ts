// Synthetic HTTP UI interactions; this does not validate a real adapter or daemon registration.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Route } from "playwright-core";

const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4195";
const output = resolve(
  process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-registration-browser`,
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let checks = 0;
let writes = 0;
let hold = false;
let held: Route | undefined;
let existing = false;
let conflict = false;
const definition = (name = "synthetic") => ({
  name,
  adapter: "/synthetic/adapter.py",
  path: "/synthetic/tasks",
  config: { setting: "not-displayed-in-review" },
  env: { NONSECRET: "not-displayed-in-review" },
  passEnv: ["JUDGE_TOKEN"],
});
const review = (input: unknown) => ({
  definition: input,
  coverage: {
    total: 3,
    supported: 2,
    suites: [{ suite: "synthetic-suite", total: 3, supported: 2 }],
    reasons: [{ reason: "Synthetic unsupported case", tasks: 1, suites: ["synthetic-suite"] }],
  },
  metrics: [{ name: "accuracy" }],
  capabilities: { methods: ["empty", "oracle"] },
  existing,
});
await context.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/stream"))
    return route.fulfill({ contentType: "text/event-stream", body: ": synthetic\n\n" });
  if (url.pathname.endsWith("/benchmarks/check")) {
    checks++;
    if (hold) {
      held = route;
      return;
    }
    return route.fulfill({ json: review(route.request().postDataJSON()) });
  }
  if (url.pathname.endsWith("/benchmarks") && route.request().method() === "POST") {
    writes++;
    assert.equal(url.searchParams.get("createOnly"), "true");
    if (conflict)
      return route.fulfill({ status: 409, json: { error: "Synthetic concurrent name conflict" } });
    return route.fulfill({
      json: { ...route.request().postDataJSON(), createdAt: "2026-11-26", updatedAt: "2026-11-26" },
    });
  }
  if (url.pathname.endsWith("/bench/init"))
    return route.fulfill({
      json: {
        directory: "/tmp/synthetic",
        files: ["benchmark.json"],
        nextSteps: ["orbit bench add-file benchmark.json"],
        definition: definition("tutorial"),
      },
    });
  await route.fulfill({ json: {} });
});
try {
  await page.goto(`${base}/benchmarks?mode=add`);
  await page.getByRole("button", { name: "Import definition", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Definition JSON", exact: true });
  const check = page.getByRole("button", { name: "Check definition", exact: true });
  const register = page.getByRole("button", { name: "Register local setup", exact: true });
  await input.fill("{");
  await check.click();
  await page.getByRole("alert").filter({ hasText: "valid benchmark JSON" }).waitFor();
  assert.equal(checks, 0);
  await input.fill(JSON.stringify(definition()));
  await check.focus();
  await page.keyboard.press("Enter");
  const checked = page.getByRole("region", { name: "Checked definition", exact: true });
  await checked.waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Checked definition", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(writes, 0);
  assert.doesNotMatch(await checked.innerText(), /not-displayed-in-review/);
  await checked.getByText("Suite coverage (1)", { exact: true }).click();
  await checked.getByText("Unsupported reasons (1)", { exact: true }).click();
  assert.match(await checked.innerText(), /2 supported \/ 3 listed/);
  assert.match(await checked.innerText(), /JUDGE_TOKEN/);
  await input.fill(JSON.stringify(definition("changed")));
  assert.equal(await checked.count(), 0);
  assert.equal(await register.isDisabled(), true);
  hold = true;
  await check.click();
  await page.waitForFunction(() => document.body.innerText.includes("Checking definition…"));
  while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
  await input.fill(JSON.stringify(definition("newer")));
  hold = false;
  await check.click();
  await checked.waitFor();
  assert.match(await checked.innerText(), /newer/);
  await held.fulfill({ json: review(definition("changed")) });
  await page.getByRole("button", { name: "Check definition", exact: true }).waitFor();
  assert.match(await checked.innerText(), /newer/);
  existing = true;
  await check.click();
  await page.getByRole("link", { name: "View existing setup", exact: true }).waitFor();
  assert.equal(await register.isDisabled(), true);
  existing = false;
  await input.fill(JSON.stringify(definition("unique")));
  await check.click();
  await checked.waitFor();
  conflict = true;
  await register.click();
  await page.getByRole("alert").filter({ hasText: "concurrent name conflict" }).waitFor();
  assert.equal(await register.isDisabled(), true);
  conflict = false;
  await check.click();
  await checked.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await checked.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "narrow-review.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await register.click();
  const success = page.getByRole("region", { name: "Benchmark registered", exact: true });
  await success.waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Local setup registered", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.match(
    (await success
      .getByRole("link", { name: "View setup and task coverage" })
      .getAttribute("href")) ?? "",
    /ptab=coverage/,
  );
  assert.equal(
    await success.getByRole("link", { name: "Evaluate", exact: true }).getAttribute("href"),
    "/bench/new?benchmark=unique",
  );
  assert.equal(new URL(page.url()).searchParams.has("definition"), false);
  await page.screenshot({ path: resolve(output, "narrow-success.png"), fullPage: true });
  await page.goto(`${base}/benchmarks?mode=add`);
  await page.getByRole("button", { name: "Import definition", exact: true }).click();
  await page.getByLabel("Definition JSON file", { exact: true }).setInputFiles({
    name: "too-big.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(1024 * 1024 + 1),
  });
  await page.getByRole("alert").filter({ hasText: "1 MiB" }).waitFor();
  await page.evaluate(
    (oldText) => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        if (this.name !== "slow.json") return original.call(this);
        return new Promise<string>((resolve) =>
          setTimeout(() => {
            resolve(oldText);
            document.documentElement.dataset.slowFileRead = "done";
          }, 400),
        );
      };
    },
    JSON.stringify(definition("stale-file")),
  );
  await page
    .getByLabel("Definition JSON file", { exact: true })
    .setInputFiles({ name: "slow.json", mimeType: "application/json", buffer: Buffer.from("{}") });
  await input.fill(JSON.stringify(definition("after-slow-file")));
  await check.click();
  await checked.waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.slowFileRead === "done");
  assert.match(await input.inputValue(), /after-slow-file/);
  assert.match(await checked.innerText(), /after-slow-file/);
  await page.getByLabel("Definition JSON file", { exact: true }).setInputFiles({
    name: "fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(definition("upload"))),
  });
  await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("upload"));
  await check.click();
  await checked.waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await checked.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Show tutorial form", exact: true }).click();
  await page.getByRole("textbox", { name: "Benchmark name", exact: true }).fill("tutorial");
  await page
    .getByRole("textbox", { name: "New directory on the daemon machine", exact: true })
    .fill("/tmp/synthetic");
  await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
  await page.getByRole("button", { name: "Continue to registration", exact: true }).click();
  assert.match(await input.inputValue(), /tutorial/);
  assert.equal(await checked.count(), 0);
  assert.equal(await register.isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    "passed: synthetic HTTP parsing, upload limits, check without registration, edit invalidation, stale check, duplicate and concurrent conflict, explicit registration, tutorial handoff, keyboard and 390px layout",
  );
} finally {
  await browser.close();
}
