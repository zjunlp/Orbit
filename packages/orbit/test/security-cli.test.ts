// CLI wiring uses explicit client, stdin and browser-launch doubles; no external services.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { readStdinSecret } from "../src/cli/confirm.ts";
import { createProgram } from "../src/cli/program.ts";
import { OrbitClient, tryConnect } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import type { Run } from "../src/contracts/index.ts";

vi.mock("../src/client/index.ts", async (original) => ({
  ...(await original<typeof import("../src/client/index.ts")>()),
  tryConnect: vi.fn(),
}));
vi.mock("../src/cli/confirm.ts", async (original) => ({
  ...(await original<typeof import("../src/cli/confirm.ts")>()),
  readStdinSecret: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const home = mkdtempSync(join(tmpdir(), "orbit-security-cli-"));
const paths = orbitPaths({ ORBIT_HOME: home });
const client = new OrbitClient({ url: "http://unused", token: "fixture-daemon-token", pid: 0 });
const parse = (args: string[]) =>
  createProgram({ runDaemon: vi.fn() }, paths).parseAsync(args, { from: "user" });
beforeEach(() => {
  vi.mocked(tryConnect).mockResolvedValue(client);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

it("opens only a one-time code in argv while keeping the printed token URL usable", async () => {
  const code = "a".repeat(48);
  const mint = vi
    .spyOn(client, "loginCode")
    .mockResolvedValue({ code, expiresAt: "2026-10-16T00:00:30.000Z" });
  const child = { on: vi.fn().mockReturnThis(), unref: vi.fn() } as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  await parse(["web", "fixture", "--open"]);
  expect(mint).toHaveBeenCalledOnce();
  expect(spawn).toHaveBeenCalledWith(
    `xdg-open`,
    [`http://unused/login?code=${code}&next=%2Fruns%2Ffixture`],
    { detached: true, stdio: "ignore" },
  );
  expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(client.info.token);
  expect(console.log).toHaveBeenCalledWith(
    "http://unused/login?token=fixture-daemon-token&next=%2Fruns%2Ffixture",
  );
  mint.mockClear();
  vi.mocked(spawn).mockClear();
  await parse(["web"]);
  expect(mint).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it.each(["stdin", "env", "argv"])(
  "reads webhook URLs from %s and warns only for argv",
  async (source) => {
    const url = "https://webhook.invalid/fixture-secret";
    vi.mocked(readStdinSecret).mockResolvedValue(url);
    vi.stubEnv("ORBIT_TEST_WEBHOOK", url);
    const put = vi.spyOn(client, "notifyPut").mockResolvedValue({
      name: "team",
      kind: "webhook",
      urlHint: "https://webhook.invalid",
      on: ["failed"],
    });
    const option =
      source === "stdin"
        ? ["--url-stdin"]
        : source === "env"
          ? ["--url-env", "ORBIT_TEST_WEBHOOK"]
          : ["--url", url];
    await parse(["notify", "add", "team", "--kind", "webhook", "--on", "failed", ...option]);
    expect(put).toHaveBeenCalledWith({ name: "team", kind: "webhook", url, on: ["failed"] });
    if (source === "stdin") expect(readStdinSecret).toHaveBeenCalledWith("Paste the webhook URL");
    if (source === "argv")
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("process arguments"));
    else expect(console.error).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(url);
  },
);

it("rejects empty stdin and missing webhook environment variables", async () => {
  const put = vi.spyOn(client, "notifyPut");
  vi.mocked(readStdinSecret).mockResolvedValue("");
  vi.stubEnv("ORBIT_TEST_WEBHOOK", "");
  for (const args of [["--url-stdin"], ["--url-env", "ORBIT_TEST_WEBHOOK"]])
    await expect(parse(["notify", "add", "team", "--kind", "webhook", ...args])).rejects.toThrow(
      /give --url-stdin/,
    );
  expect(put).not.toHaveBeenCalled();
});

it.each([false, true])("waits for new log bytes only when following: %s", async (follow) => {
  vi.useFakeTimers();
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const logs = vi
    .spyOn(client, "logs")
    .mockResolvedValueOnce({ offset: 0, next: 10, size: 30, text: "safe text\n", eof: false })
    .mockResolvedValueOnce({ offset: 10, next: 10, size: 30, text: "", eof: false });
  if (follow)
    logs.mockResolvedValueOnce({ offset: 10, next: 30, size: 30, text: "[redacted]\n", eof: true });
  logs.mockRejectedValue(new Error("unexpected busy polling"));
  const get = vi
    .spyOn(client, "get")
    .mockResolvedValue({ state: "running", cleanup: "pending" } as Run);
  const task = parse(["logs", "fixture", ...(follow ? ["--follow"] : [])]);
  await vi.advanceTimersByTimeAsync(0);
  expect(logs).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(follow ? 1 : 0);
  await vi.advanceTimersByTimeAsync(1000);
  await task;
  expect(logs).toHaveBeenCalledTimes(follow ? 3 : 2);
  expect(write).toHaveBeenCalledWith("safe text\n");
});

it("passes negative offsets for logs --tail and rejects non-positive values", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const logs = vi
    .spyOn(client, "logs")
    .mockResolvedValue({ offset: 20, next: 30, size: 30, text: "tail line\n", eof: true });
  await parse(["logs", "fixture", "--tail", "128"]);
  expect(logs).toHaveBeenCalledWith("fixture", -128);
  expect(write).toHaveBeenCalledWith("tail line\n");
  logs.mockClear();
  for (const bad of ["0", "-5", "1.5"])
    await expect(parse(["logs", "fixture", "--tail", bad])).rejects.toThrow(/positive integer/);
  expect(logs).not.toHaveBeenCalled();
});
