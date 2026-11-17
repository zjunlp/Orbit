import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Route } from "playwright-core";
import {
  conversationJob,
  conversationRun,
  type LongConversation,
  longConversation,
} from "../fixtures/conversation.ts";

const base = process.env.ORBIT_WEB_URL ?? "http://127.0.0.1:4186";
const output = resolve(
  process.env.ORBIT_BROWSER_OUTPUT ?? `${tmpdir()}/orbit-conversation-browser`,
);
const baseline = process.env.ORBIT_BROWSER_BASELINE === "1";
const measure = process.env.ORBIT_BROWSER_MEASURE === "1" || baseline;
const demo = process.env.ORBIT_BROWSER_VIDEO === "1";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.ORBIT_CHROMIUM_PATH ? { executablePath: process.env.ORBIT_CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
  slowMo: demo ? 100 : 0,
});
const context = await browser.newContext({
  viewport: { width: 1540, height: 1050 },
  ...(demo ? { recordVideo: { dir: output, size: { width: 1540, height: 1050 } } } : {}),
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [];
const checks: string[] = [];
const timings: {
  sample: LongConversation;
  repeat: number;
  openMs: number;
  searchMs: number;
  jumpMs: number;
  mountedEvents: number;
  mountedTurns: number;
}[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const samples = {
  "many-turns": longConversation("many-turns"),
  "single-turn": longConversation("single-turn"),
};
const sizes = Object.fromEntries(
  Object.entries(samples).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]),
);
const job = conversationJob();
let pendingHold: ReturnType<typeof holdNext> | undefined;
const releases = new Set<() => void>();
function holdNext(path: string) {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let started = () => {};
  const request = new Promise<void>((done) => {
    started = done;
  });
  let finished = () => {};
  const response = new Promise<void>((done) => {
    finished = done;
  });
  const hold = { path, gate, request, response, release, started, finished };
  pendingHold = hold;
  releases.add(release);
  return hold;
}
const counts = new Map<string, number>();
await context.addInitScript(() => {
  const state = window as unknown as { reads: { url: string; aborted: boolean }[] };
  state.reads = [];
  const original = window.fetch;
  window.fetch = (input, init) => {
    const read = { url: String(input), aborted: init?.signal?.aborted ?? false };
    state.reads.push(read);
    init?.signal?.addEventListener(
      "abort",
      () => {
        read.aborted = true;
      },
      { once: true },
    );
    // Explicitly simulate a transport ignoring cancellation to exercise the stale-response guard.
    const ignore = new URLSearchParams(location.search).has("ignoreAbort");
    return original(input, ignore ? { ...init, signal: undefined } : init);
  };
});
await context.route("**/api/v1/**", async (route: Route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  let json: unknown = {};
  if (path.endsWith("/stream"))
    return route.fulfill({ contentType: "text/event-stream", body: ": SYNTHETIC test stream\n\n" });
  if (path.endsWith("/runs")) json = { runs: [], next: null };
  else if (path.includes("/bench/jobs/")) json = job;
  else if (path.includes("/runs/")) {
    const id = path.split("/")[4] ?? "";
    const sample = id.endsWith("many-turns") ? "many-turns" : "single-turn";
    if (id.startsWith("probe-")) {
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      json = { marker: `${id}-${count}` };
    } else if (path.endsWith("/environment")) json = samples[sample];
    else if (path.endsWith("/artifacts"))
      json = {
        files: [{ path: "conversation.json", bytes: sizes[sample], mtime: "2026-11-17T00:00:00Z" }],
        truncated: false,
      };
    else if (path.endsWith("/session")) json = { agent: null, submitter: null };
    else json = conversationRun(id);
  }
  const hold = pendingHold?.path === path ? pendingHold : undefined;
  if (hold) {
    pendingHold = undefined;
    hold.started();
    await hold.gate;
  }
  try {
    await route.fulfill({ json });
  } catch (error) {
    if (!hold && !page.isClosed()) throw error;
  } finally {
    hold?.finished();
    if (hold) releases.delete(hold.release);
  }
});
const paint = () =>
  page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
const trialUrl = (sample: LongConversation, turn = 0) =>
  `${base}/bench/synthetic-conversations/trials/${sample}?turn=${turn}`;
const search = () => page.getByRole("searchbox", { name: "Search the conversation" });
async function opened(sample: LongConversation, turn = 0) {
  await page.goto(trialUrl(sample, turn));
  await page.locator(".conv-main .conv-msg").first().waitFor();
  await paint();
}
async function turnVisible(turn: number) {
  await page.waitForFunction((n) => {
    const row = document.getElementById(`turn-${n}`)?.getBoundingClientRect();
    const box = document.querySelector(".conv-main")?.getBoundingClientRect();
    return row && box && row.top >= box.top - 2 && row.top < box.bottom;
  }, turn);
}
async function lastEventVisible(last = 4999) {
  await page.waitForFunction((last) => {
    const box = document.querySelector(".conv-main")?.getBoundingClientRect();
    return (
      box &&
      [...document.querySelectorAll(".conv-call-h")].some((el) => {
        const rect = el.getBoundingClientRect();
        return (
          el.textContent?.includes(`needle-tool-${last}`) &&
          rect.top >= box.top &&
          rect.top < box.bottom
        );
      })
    );
  }, last);
}
async function bounded() {
  assert((await page.locator(".conv-msg, .conv-call").count()) < 60);
  assert((await page.locator(".conv-turn-link").count()) < 35);
}
async function readIndex(path: string) {
  return page.evaluate((path) => {
    const reads = (window as unknown as { reads: { url: string }[] }).reads;
    return reads.findLastIndex((r) => r.url.includes(path));
  }, path);
}
async function deadline(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for a held fixture request")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function aborted(index: number) {
  assert(index >= 0, "The held request must carry a recorded AbortSignal");
  await page.waitForFunction(
    (index) => (window as unknown as { reads: { aborted: boolean }[] }).reads[index]?.aborted,
    index,
  );
}

try {
  await opened("many-turns");
  if (measure) {
    for (const sample of ["many-turns", "single-turn"] as const) {
      for (let repeat = 0; repeat < 5; repeat++) {
        let start = performance.now();
        await opened(sample);
        const openMs = performance.now() - start;
        const mountedEvents = await page.locator(".conv-msg, .conv-call").count();
        const mountedTurns = await page.locator(".conv-turn-link").count();
        start = performance.now();
        await search().fill(`result-marker-${sample === "many-turns" ? 9999 : 4999}`);
        await page.getByText("1 matching events", { exact: true }).waitFor();
        await paint();
        const searchMs = performance.now() - start;
        await search().fill("");
        await paint();
        await search().blur();
        start = performance.now();
        if (sample === "many-turns") {
          await page.keyboard.press("e");
          await turnVisible(850);
        } else {
          await page.locator(".conv-main").evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          await lastEventVisible();
        }
        await paint();
        timings.push({
          sample,
          repeat,
          openMs,
          searchMs,
          jumpMs: performance.now() - start,
          mountedEvents,
          mountedTurns,
        });
        console.log(`Measured ${sample} ${repeat + 1}/5`);
      }
    }
  }
  if (!baseline) {
    await opened("many-turns", 999);
    await turnVisible(999);
    await bounded();
    await page.locator(".conv-turn-link.on").waitFor({ state: "visible" });
    await page.reload();
    await turnVisible(999);
    await page.keyboard.press("h");
    await turnVisible(998);
    await page.keyboard.press("l");
    await turnVisible(999);
    await page.keyboard.press("e");
    await turnVisible(850);
    await page.keyboard.press("h");
    await turnVisible(849);
    await page.getByRole("button", { name: "First detected at turn 851", exact: false }).click();
    await turnVisible(850);
    await page.locator(".conv-main").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.keyboard.press("e");
    await turnVisible(850);
    await page.evaluate(() => {
      history.pushState(null, "", "?turn=10");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await turnVisible(10);
    checks.push(
      "URL deep link/reload/history, h/l/e, failure button, repeated jump and rail selection",
    );
    await page.keyboard.press("/");
    assert(await search().evaluate((el) => document.activeElement === el));
    await search().fill("RESULT-MARKER-9999");
    await page.getByText("1 matching events", { exact: true }).waitFor();
    const result = page.locator('[data-event-key="999:event:9"] .conv-call-h');
    await result.waitFor();
    await page.setViewportSize({ width: 1280, height: 1050 });
    await paint();
    await result.waitFor();
    await page.setViewportSize({ width: 1540, height: 1050 });
    await result.click();
    await page
      .locator(".conv-call-b")
      .getByText(/result-marker-9999/)
      .waitFor();
    await search().fill("no-such-event");
    await page.getByText("0 matching events", { exact: true }).waitFor();
    await bounded();
    await search().press("Escape");
    await turnVisible(999);
    await page.locator(".conv-main").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.keyboard.press("e");
    await turnVisible(850);
    await page.screenshot({ path: `${output}/many-turns.png` });
    checks.push(
      "search includes offscreen collapsed results; expand, empty search and Escape preserve navigation",
    );
    await opened("single-turn");
    await bounded();
    const first = page.locator('[data-event-key="0:event:1"] .conv-call-h');
    await first.click();
    assert.equal(await first.getAttribute("aria-expanded"), "true");
    await page.locator(".conv-main").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await lastEventVisible();
    assert.equal(await first.count(), 0);
    await bounded();
    await page.locator(".conv-turn-link").click();
    await turnVisible(0);
    assert.equal(await first.getAttribute("aria-expanded"), "true");
    await search().fill("result-marker-4999");
    await page.getByText("1 matching events", { exact: true }).waitFor();
    await page.locator('[data-event-key="0:event:4999"] .conv-call-h').click();
    await page.screenshot({ path: `${output}/single-turn.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await paint();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await search().isVisible());
    await search().fill("needle-event-4998");
    await page.getByText("1 matching events", { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/mobile.png` });
    await page.setViewportSize({ width: 1540, height: 1050 });
    checks.push(
      "single 5,000-event turn stays virtual through end scrolling, card expansion, remount and mobile search",
    );
    for (const phase of ["run", "artifacts", "session", "environment"] as const) {
      const path =
        phase === "run"
          ? "/api/v1/runs/verify-many-turns"
          : `/api/v1/runs/${phase === "session" ? "solve" : "verify"}-many-turns/${phase}`;
      const hold = holdNext(path);
      await page.goto(trialUrl("many-turns"));
      await deadline(hold.request);
      const heldRead = await readIndex(path);
      await page.locator(".trial-nav a").filter({ hasText: "Next ›" }).click();
      await page
        .locator(".conv-main .conv-text")
        .filter({ hasText: "SYNTHETIC single-turn: needle-event-0" })
        .waitFor();
      await aborted(heldRead);
      hold.release();
      await deadline(hold.response);
      await paint();
      assert.equal(
        await page
          .locator(".conv-main")
          .getByText(/SYNTHETIC many-turns/)
          .count(),
        0,
      );
      assert.equal(await page.getByText("Conversation unavailable", { exact: true }).count(), 0);
      checks.push(
        `real browser: switching Trial aborts delayed ${phase} read and keeps current Trial content`,
      );
    }
    for (const action of ["refresh", "leave"] as const) {
      const path = "/api/v1/runs/verify-many-turns/environment";
      const hold = holdNext(path);
      await page.goto(trialUrl("many-turns"));
      await deadline(hold.request);
      const heldRead = await readIndex(path);
      if (action === "refresh") {
        await page.getByRole("button", { name: "Refresh conversation", exact: true }).click();
        await page.locator(".conv-main .conv-msg").first().waitFor();
      } else {
        await page.getByRole("link", { name: "Configuration", exact: true }).click();
        await page.locator(".conv").waitFor({ state: "detached" });
      }
      await aborted(heldRead);
      hold.release();
      await deadline(hold.response);
      await paint();
      assert.equal(await page.getByText("Conversation unavailable", { exact: true }).count(), 0);
      checks.push(
        `Conversation page ${action} aborts the delayed environment request without showing an error`,
      );
    }
    // Probe the shared hook without remounting it, including a deliberately non-cooperative fetch.
    for (const query of ["", "?file=1", "?ignoreAbort=1"]) {
      const path = `/api/v1/runs/probe-A/${query.includes("file") ? "files/probe.txt" : "session"}`;
      await page.goto(`${base}/test/browser/async.html${query}`);
      const value = page.getByTestId("value");
      await page.waitForFunction(() =>
        document.querySelector("[data-testid=value]")?.textContent?.includes("probe-A"),
      );
      const old = holdNext(path);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await deadline(old.request);
      const oldRead = await readIndex(path);
      const bPath = path.replace("probe-A", "probe-B");
      const next = holdNext(bPath);
      await page.getByRole("button", { name: "Trial B" }).click();
      await deadline(next.request);
      assert.equal(await value.innerText(), "loading");
      await aborted(oldRead);
      next.release();
      await deadline(next.response);
      await page.waitForFunction(() =>
        document.querySelector("[data-testid=value]")?.textContent?.includes("probe-B"),
      );
      const current = await value.innerText();
      old.release();
      await deadline(old.response);
      await paint();
      assert.equal(await value.innerText(), current);
      const refresh = holdNext(bPath);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await deadline(refresh.request);
      const refreshRead = await readIndex(bPath);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await aborted(refreshRead);
      refresh.release();
      await deadline(refresh.response);
      await paint();
      assert.equal(await page.getByTestId("error").innerText(), "");
      const leave = holdNext(bPath);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await deadline(leave.request);
      const leaveRead = await readIndex(bPath);
      await page.getByRole("button", { name: "Leave", exact: true }).click();
      await aborted(leaveRead);
      leave.release();
      await deadline(leave.response);
      checks.push(
        `shared useAsync ${query || "API"}: identity clears old content, refresh/unmount abort, cancellation stays silent, stale response ignored`,
      );
    }
  }
  assert.deepEqual(errors, []);
  const report = {
    status: "passed",
    fixtures: "SYNTHETIC / 1,000 turns + 10,000 events; 1 turn + 5,000 events / intercepted API",
    browser: browser.version(),
    viewport: { width: 1540, height: 1050 },
    phase: baseline ? "before" : "after",
    timing:
      "Warm Vite cache; wall time through target render and two animation frames; five repetitions; search filters hidden result; jump to failure or end of single turn.",
    timings,
    checks,
    errors,
  };
  await writeFile(`${output}/results.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  console.error({ checks, errors });
  throw error;
} finally {
  for (const release of releases) release();
  await context.close();
  const video = await page.video()?.path();
  if (video) {
    const recording = `${output}/conversation-demo.webm`;
    await rename(video, recording);
    console.log(`Browser recording: ${recording}`);
  }
  await browser.close();
}
