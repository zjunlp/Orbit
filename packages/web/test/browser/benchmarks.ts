// Interaction checks use synthetic HTTP catalog data, never a real benchmark backend.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4187";
const output = resolve(process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-benchmarks-browser`);
await mkdir(output, { recursive: true });
const definition = {
  id: "synthetic",
  name: "Synthetic benchmark",
  description: "Explicit synthetic UI fixture.",
  taxonomyGroups: [
    { label: "Science terminal", taxonomy: { domains: ["science"], interfaces: ["terminal"] } },
    { label: "Software GUI", taxonomy: { domains: ["software"], interfaces: ["gui"] } },
  ],
  integrations: [
    { name: "Synthetic adapter", url: "https://example.test", scope: "Synthetic scope" },
  ],
  verification: {
    detail: "Synthetic metadata; no real backend validation.",
    url: "https://example.test",
  },
  suites: ["fixture"],
  registrationNames: ["synthetic-a", "synthetic-b"],
};
const entries = definition.registrationNames.map((name) => ({
  benchmark: {
    name,
    adapter: "sdk",
    path: "/synthetic",
    config: {},
    env: {},
    passEnv: [],
    createdAt: "2026-11-01",
    updatedAt: "2026-11-01",
  },
  listing: null,
  capabilities: null,
  identity: { id: definition.id, name: definition.name },
  identitySource: "adapter",
  listingError: null,
  refreshing: false,
  calibrations: [],
  jobs: 0,
  methods: [],
}));
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/api/v1/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/stream"))
    return route.fulfill({ contentType: "text/event-stream", body: ": synthetic\n\n" });
  const json = path.endsWith("/bench/catalog")
    ? {
        entries,
        supported: [
          definition,
          {
            ...definition,
            id: "unregistered",
            name: "Unregistered fixture",
            registrationNames: [],
          },
        ],
      }
    : path.endsWith("/runs")
      ? { runs: [], next: null }
      : path.endsWith("/methods")
        ? { methods: [] }
        : {};
  await route.fulfill({ json });
});
try {
  await page.goto(`${base}/benchmarks`);
  await page.getByRole("heading", { name: definition.name, exact: true }).waitFor();
  await page.getByRole("combobox", { name: "Filter by local setup" }).selectOption("registered");
  assert.equal(await page.locator("article.supported-benchmark").count(), 1);
  assert.equal(new URL(page.url()).searchParams.get("local"), "registered");
  const choose = page.getByRole("button", { name: "Choose local setup", exact: true });
  await choose.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("link", { name: "Evaluate", exact: true }).count(), 2);
  assert.match(
    await page.locator(".supported-local-setups").innerText(),
    /Registration alone does not establish readiness or calibration/,
  );
  await page.getByRole("button", { name: "Domain", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Software engineering/ }).click();
  assert.equal(new URL(page.url()).searchParams.get("domains"), "software");
  await page.getByRole("button", { name: "Close filters", exact: true }).click();
  await page.goto(`${base}/benchmarks?domains=software&interfaces=gui&open=synthetic`);
  const profile = page.getByRole("combobox", { name: "Protocol profile" });
  assert.equal(await profile.inputValue(), "1");
  await profile.selectOption("0");
  assert.equal(new URL(page.url()).searchParams.get("profile"), "0");
  await page.reload();
  assert.equal(await profile.inputValue(), "0");
  await page.goto(`${base}/benchmarks?domains=science&interfaces=gui`);
  await page.getByRole("heading", { name: "No benchmarks match these filters" }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  assert.equal(await page.locator("article.supported-benchmark").count(), 2);
  await page.getByRole("searchbox", { name: "Search benchmarks" }).fill("no-such-fixture");
  await page.getByRole("heading", { name: "No benchmarks match these filters" }).waitFor();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.getByRole("link", { name: "Local setups", exact: true }).click();
  await page.goBack();
  await page.getByRole("heading", { name: definition.name, exact: true }).waitFor();
  await page.goto(`${base}/benchmarks?mode=local&setup=synthetic-a`);
  await page.getByRole("button", { name: "Setup: synthetic-a" }).waitFor();
  assert.equal(await page.locator("article.benchmark-card").count(), 1);
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.has("setup"), false);
  assert.equal(await page.locator("article.benchmark-card").count(), 2);
  await page.goto(`${base}/benchmarks?local=registered&open=synthetic&domains=software`);
  await page.getByRole("combobox", { name: "Protocol profile" }).waitFor();
  await page.locator(".benchmark-card-footer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".benchmark-card-footer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "narrow.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  definition.registrationNames = ["synthetic-a"];
  await page.reload();
  await page.getByRole("link", { name: "View setup", exact: true }).first().waitFor();
  await page.locator(".benchmark-card-footer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "narrow-single-setup.png"), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "passed: synthetic HTTP benchmark filters, keyboard setup selection, same-profile matching, profile URL reload, history back, empty states, setup clear, desktop and narrow layout",
  );
} finally {
  await browser.close();
}
