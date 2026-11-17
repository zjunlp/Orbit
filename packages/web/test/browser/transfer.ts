// Browser interaction check with synthetic archived gate evidence and explicitly stubbed HTTP data.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { transferMatrix } from "../../../orbit/src/bench/transfer.ts";
import { GateRecord } from "../../../orbit/src/contracts/index.ts";
import { fixture } from "../../../orbit/test/fixtures/gate.ts";

const f = fixture();
f.policy.final.push({
  benchmark: "heldout",
  tasks: { file: "heldout.txt", sha256: "c".repeat(64) },
  agents: ["other-agent"],
});
const record = GateRecord.parse({
  id: "synthetic-transfer",
  createdAt: "2026-11-17T00:00:00Z",
  evaluator: "orbit-gate/1",
  mode: "promotion",
  policy: f.policy,
  evidence: f.evidence,
  verdict: f.check(),
});
const matrix = transferMatrix([record]);
const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4187";
const output = resolve(process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-transfer-browser`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors: string[] = [];
const checks: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
let fail = false;
let reads = 0;
await context.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  let json: unknown = {};
  if (path.endsWith("/stream"))
    return route.fulfill({ contentType: "text/event-stream", body: ": SYNTHETIC stream\n\n" });
  if (path.endsWith("/runs")) json = { runs: [], next: null };
  else if (path.endsWith("/methods")) json = { methods: [] };
  else if (path.endsWith("/bench/gates")) json = { records: [record] };
  else if (path.endsWith(`/bench/gates/${record.id}`)) json = record;
  else if (path.endsWith("/bench/transfer")) {
    reads++;
    if (fail)
      return route.fulfill({ status: 503, json: { error: "Synthetic temporary read failure" } });
    json =
      url.searchParams.get("childBundle") === "c".repeat(64)
        ? { rows: [], columns: [], omitted: [] }
        : matrix;
  }
  await route.fulfill({ json });
});
try {
  await page.goto(`${base}/configurations`);
  await page.getByRole("link", { name: "Transfer matrix", exact: true }).click();
  await page.getByRole("heading", { name: "Transfer evidence", exact: true }).waitFor();
  const button = page.getByRole("button", {
    name: "Review fixture codex Admission for bbbbbbbbbbbb",
    exact: true,
  });
  await button.waitFor();
  assert.match(await button.innerText(), /Δ \+15/);
  assert.match(
    await page
      .getByRole("button", {
        name: "Review heldout other-agent Final for bbbbbbbbbbbb",
        exact: true,
      })
      .innerText(),
    /Missing evidence/,
  );
  await button.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Selected transfer evidence" }).waitFor();
  assert(new URL(page.url()).searchParams.has("condition"));
  const selectedURL = page.url();
  await page.reload();
  await page.getByRole("region", { name: "Selected transfer evidence" }).waitFor();
  assert.equal(page.url(), selectedURL);
  checks.push("navigation, keyboard cell selection and URL persistence");
  await page.getByText("Frozen evaluation conditions", { exact: true }).click();
  await page
    .getByText("Submitted resource overrides (unknown values were not frozen):")
    .first()
    .waitFor();
  await page.screenshot({ path: resolve(output, "matrix.png"), fullPage: true });
  await page.getByRole("link", { name: "Open saved assessment" }).click();
  await page.getByRole("heading", { name: "Accepted", exact: true }).waitFor();
  await page.getByRole("link", { name: "Transfer evidence for this bundle change" }).click();
  await button.waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Parent bundle digest" }).inputValue(),
    "a".repeat(64),
  );
  checks.push("archived assessment link and exact bundle filter return");
  await page.getByRole("textbox", { name: "Child bundle digest" }).fill("c".repeat(64));
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("No saved transfer evidence", { exact: true }).waitFor();
  const beforeInvalid = reads;
  await page.getByRole("textbox", { name: "Child bundle digest" }).fill("bad");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("Choose two bundle digests", { exact: true }).waitFor();
  assert.equal(reads, beforeInvalid);
  checks.push("empty and invalid filters never display zero or stale scores");
  fail = true;
  await page.getByRole("button", { name: "Show all", exact: true }).click();
  await page.getByText("Transfer evidence unavailable", { exact: true }).waitFor();
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await button.waitFor();
  checks.push("API errors and retry");
  await page.setViewportSize({ width: 600, height: 900 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await button.click();
  await page.getByRole("region", { name: "Selected transfer evidence" }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: resolve(output, "matrix-narrow.png"), fullPage: true });
  checks.push("narrow light-theme layout contains the table in its scroll area");
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "checks.json"),
    JSON.stringify({ evidence: "synthetic", checks, pageErrors: errors }, null, 2),
  );
  console.log(JSON.stringify({ evidence: "synthetic", checks, output }));
} finally {
  await context.close();
  await browser.close();
}
