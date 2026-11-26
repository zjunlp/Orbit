// Browser interactions with explicitly synthetic HTTP metadata; no real backend evaluation.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4193";
const output = resolve(process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-comparison-browser`);
await mkdir(output, { recursive: true });
const supported = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((name) => ({
  id: name.toLowerCase(),
  name: `${name} fixture`,
  description: `Synthetic ${name} benchmark description.`,
  taxonomyGroups: [
    { label: "Science terminal", taxonomy: { domains: ["science"], interfaces: ["terminal"] } },
    { label: "Software GUI", taxonomy: { domains: ["software"], interfaces: ["gui"] } },
  ],
  suites: [`${name} synthetic suite`],
  integrations: [
    {
      name: "Synthetic SDK",
      url: "https://example.test/scope",
      scope: `Bounded ${name} integration scope.`,
    },
  ],
  verification: {
    detail: "Synthetic UI fixture; no real environment validation.",
    url: "https://example.test/validation",
  },
  registrationNames: name === "Alpha" ? ["synthetic-a", "synthetic-b"] : [],
}));
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/api/v1/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/stream"))
    return route.fulfill({ contentType: "text/event-stream", body: ": synthetic\n\n" });
  const json = path.endsWith("/bench/catalog")
    ? { entries: [], supported }
    : path.endsWith("/runs")
      ? { runs: [], next: null }
      : path.endsWith("/methods")
        ? { methods: [] }
        : {};
  await route.fulfill({ json });
});
try {
  await page.goto(`${base}/benchmarks`);
  const alpha = page.getByRole("button", { name: "Compare Alpha fixture", exact: true });
  await alpha.focus();
  await page.keyboard.press("Enter");
  assert.equal(await alpha.getAttribute("aria-pressed"), "true");
  const compare = page.getByRole("button", { name: "Compare selected", exact: true });
  assert.equal(await compare.isDisabled(), true);
  await page.getByRole("searchbox", { name: "Search benchmarks" }).fill("Beta");
  await page.getByRole("button", { name: "Compare Beta fixture", exact: true }).click();
  await page
    .getByText("1 selected family is hidden by current filters.", { exact: false })
    .waitFor();
  await compare.click();
  const table = page.getByRole("region", { name: "Benchmark comparison table", exact: true });
  await table.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("q"), "Beta");
  assert.equal(await table.getByRole("columnheader").count(), 3);
  const profile = page.getByRole("combobox", { name: "Protocol profile for Alpha fixture" });
  await profile.selectOption("1");
  assert.equal(new URL(page.url()).searchParams.get("compareProfile.alpha"), "1");
  await page.reload();
  assert.equal(await profile.inputValue(), "1");
  const domainRow = table
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Domain", exact: true }) });
  assert.match(await domainRow.getByRole("cell").first().innerText(), /Software engineering/);
  assert.doesNotMatch(await domainRow.getByRole("cell").first().innerText(), /Natural science/);
  await table.getByText("Choose a local setup", { exact: true }).click();
  assert.equal(await table.getByRole("link", { name: "Evaluate", exact: true }).count(), 2);
  await table.getByRole("columnheader").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "desktop-top.png"), fullPage: true });
  await table.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to cards", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search benchmarks" }).fill("");
  for (const name of ["Gamma", "Delta"])
    await page.getByRole("button", { name: `Compare ${name} fixture`, exact: true }).click();
  const epsilon = page.getByRole("button", { name: "Compare Epsilon fixture", exact: true });
  assert.equal(await epsilon.isDisabled(), true);
  await page
    .getByRole("button", { name: "Remove Beta fixture from comparison", exact: true })
    .click();
  assert.equal(await epsilon.isDisabled(), false);
  await epsilon.click();
  assert.equal(new URL(page.url()).searchParams.get("compare"), "alpha,gamma,delta,epsilon");
  await page.getByRole("button", { name: "Domain", exact: true }).click();
  await page.getByRole("button", { name: /Natural science/ }).click();
  assert.equal(new URL(page.url()).searchParams.get("compare"), "alpha,gamma,delta,epsilon");
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.has("compare"), true);
  await page.goto(
    `${base}/benchmarks?view=compare&compare=unknown,alpha,alpha,beta,gamma,delta,epsilon&q=no-match`,
  );
  await page
    .getByText("1 unavailable family ID was ignored from this URL.", { exact: true })
    .waitFor();
  await page
    .getByText("Only the first 4 available families from this URL are selected.", { exact: true })
    .waitFor();
  assert.equal(await table.getByRole("columnheader").count(), 5);
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get("compare"), "alpha,gamma,delta,epsilon");
  await page.goForward();
  await table.waitFor();
  assert.equal(await table.getByRole("columnheader").count(), 5);
  await page.setViewportSize({ width: 390, height: 844 });
  await table.scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  assert.equal(await table.evaluate((element) => element.scrollWidth > element.clientWidth), true);
  await table.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => (document.querySelector(".comparison-scroll")?.scrollLeft ?? 0) > 0,
  );
  await page.screenshot({ path: resolve(output, "narrow.png"), fullPage: true });
  await table.getByRole("columnheader").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "narrow-top.png"), fullPage: true });
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page
    .getByRole("heading", { name: "Select at least two benchmark families", exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).searchParams.has("compare"), false);
  assert.equal(new URL(page.url()).searchParams.get("q"), "no-match");
  await page.getByRole("button", { name: "Browse benchmark cards", exact: true }).click();
  await page
    .getByRole("heading", { name: "No benchmarks match these filters", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "passed: synthetic HTTP comparison selection, keyboard, hidden selections, profile reload, four-family limit, invalid shared IDs, clearing, and narrow table-only scrolling",
  );
} finally {
  await browser.close();
}
