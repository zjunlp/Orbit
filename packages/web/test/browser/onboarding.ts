// Synthetic HTTP checks only: no real daemon writes or benchmark calibration.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4188";
const output = resolve(process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-onboarding-browser`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let calls = 0;
let release = () => {};
let fail = true;
let held = false;
const writes: unknown[] = [];
await page.route("**/api/v1/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/bench/init")) {
    calls++;
    const body = route.request().postDataJSON();
    writes.push(body);
    if (held)
      await new Promise<void>((done) => {
        release = done;
      });
    if (fail)
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic target already exists" }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...body,
        directory: "/synthetic/server returned",
        tutorial: true,
        files: ["README.md", "server-returned.py"],
        nextSteps: ["orbit bench coverage 'synthetic'"],
      }),
    });
  }
  const body = path.endsWith("/health")
    ? { ok: true, version: "synthetic", pid: 1, startedAt: "2026-11-26T00:00:00Z" }
    : path.endsWith("/bench/catalog")
      ? { entries: [], supported: [] }
      : {};
  return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
});
try {
  await page.goto(`${base}/benchmarks?mode=add`);
  await page.getByRole("heading", { name: "Add your own benchmark" }).waitFor();
  assert.equal(calls, 0);
  await page.getByLabel("Benchmark name", { exact: true }).fill("synthetic");
  await page.getByLabel("New directory on the daemon machine", { exact: true }).fill("relative");
  await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
  assert.match(await page.getByRole("alert").innerText(), /absolute/);
  assert.equal(calls, 0);
  await page
    .getByLabel("New directory on the daemon machine", { exact: true })
    .fill("/synthetic/new space");
  await page.getByLabel("Template", { exact: true }).selectOption("manifest");
  assert.match(
    await page.getByRole("region", { name: "Creation preview" }).innerText(),
    /does not rerun the grader/,
  );
  await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
  await page.getByText("Synthetic target already exists", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("New directory on the daemon machine", { exact: true }).inputValue(),
    "/synthetic/new space",
  );
  fail = false;
  held = true;
  await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
  await page.getByRole("button", { name: "Creating tutorial…" }).waitFor();
  assert.equal(await page.getByLabel("Benchmark name", { exact: true }).isDisabled(), true);
  await page
    .getByRole("button", { name: "Creating tutorial…" })
    .evaluate((button: HTMLButtonElement) => button.click());
  assert.equal(calls, 2);
  release();
  await page.getByRole("heading", { name: "Tutorial created", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Tutorial created", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.match(
    await page.getByRole("region", { name: "Tutorial created" }).innerText(),
    /server-returned.py/,
  );
  assert.match(
    await page.getByRole("region", { name: "Tutorial created" }).innerText(),
    /Nothing has been registered or started/,
  );
  assert.deepEqual(writes[1], {
    name: "synthetic",
    directory: "/synthetic/new space",
    template: "manifest",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/onboarding-success-mobile.png`, fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.getByRole("button", { name: "Create another tutorial" }).click();
  await page
    .getByLabel("New directory on the daemon machine", { exact: true })
    .fill("/synthetic/late");
  await page.getByRole("button", { name: "Create tutorial", exact: true }).click();
  await page.getByRole("button", { name: "Creating tutorial…" }).waitFor();
  await page.getByRole("link", { name: "Back to library" }).click();
  await page.getByRole("link", { name: "Add your own benchmark", exact: true }).click();
  release();
  await page.getByRole("heading", { name: "Create a synthetic tutorial" }).waitFor();
  assert.equal(
    await page.getByLabel("New directory on the daemon machine", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page.getByRole("heading", { name: "Tutorial created", exact: true }).count(),
    0,
  );
  assert.equal(new URL(page.url()).search, "?mode=add");
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.includes("onboarding")),
    ),
    [],
  );
  await page.screenshot({ path: `${output}/onboarding-form-mobile.png`, fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "passed: synthetic HTTP onboarding validation, explicit submit, error recovery, pending guard, server result, stale response and 390px layout",
  );
} finally {
  await browser.close();
}
