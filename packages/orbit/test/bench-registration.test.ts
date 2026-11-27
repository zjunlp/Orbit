// Explicit adapter task-list double isolates registration validation and race behavior; no runs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterAll, expect, it, vi } from "vitest";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { BenchService } from "../src/bench/service.ts";
import { registerBench } from "../src/cli/bench.ts";
import { OrbitClient } from "../src/client/index.ts";
import { BenchRegistrationCheck } from "../src/contracts/index.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-registration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function fixture(name: string) {
  const file = join(root, `${name}.json`);
  const registry = new BenchmarkRegistry(file);
  const service = Object.create(BenchService.prototype) as BenchService;
  Object.assign(service, { deps: { registry } });
  const listing = vi.spyOn(service, "infoOf").mockResolvedValue({
    tasks: [
      { id: "suite:a", title: "a", supported: true, reason: null, tags: {} },
      { id: "suite:b", title: "b", supported: false, reason: "missing tool", tags: {} },
    ],
    metrics: [],
  });
  const input = { name, adapter: "harbor", path: root };
  return { service, registry, listing, input, file };
}
it("checks once, returns normalized summary and leaves registration unchanged", async () => {
  const { service, registry, listing, input } = fixture("preview");
  const result = BenchRegistrationCheck.parse(await service.checkRegistration(input));
  expect(result).toMatchObject({
    definition: { config: {}, env: {}, passEnv: [] },
    existing: false,
    coverage: {
      total: 2,
      supported: 1,
      reasons: [{ reason: "missing tool", tasks: 1, suites: ["suite"] }],
    },
  });
  expect(listing).toHaveBeenCalledTimes(1);
  expect(registry.list()).toEqual([]);
  await service.register(input);
  const before = registry.list();
  expect((await service.checkRegistration(input)).existing).toBe(true);
  expect(registry.list()).toEqual(before);
  const resources = join(root, "bad-resources.json");
  writeFileSync(resources, JSON.stringify({ version: 1, tasks: { unknown: { cpus: 1 } } }));
  await expect(service.checkRegistration({ ...input, resources })).rejects.toThrow();
  listing.mockRejectedValueOnce(new Error("adapter failed"));
  await expect(service.checkRegistration(input)).rejects.toThrow("adapter failed");
  expect(registry.list()).toEqual(before);
});
it("create-only rejects existing names before adapter execution and rejects an await race", async () => {
  const { service, registry, listing, input, file } = fixture("race");
  registry.put({ ...input, config: { original: "yes" } });
  const before = readFileSync(file, "utf8");
  await expect(service.register(input, { createOnly: true })).rejects.toThrow("already registered");
  expect(listing).not.toHaveBeenCalled();
  expect(readFileSync(file, "utf8")).toBe(before);
  registry.remove(input.name);
  const info = { tasks: [], metrics: [] };
  listing.mockImplementationOnce(async () => {
    registry.put({ ...input, config: { racer: "wins" } });
    return info;
  });
  await expect(service.register(input, { createOnly: true })).rejects.toThrow("already registered");
  expect(registry.get(input.name)?.config).toEqual({ racer: "wins" });
  await service.register({ ...input, config: { replacement: "yes" } });
  expect(registry.get(input.name)?.config).toEqual({ replacement: "yes" });
});
it("CLI --check prints JSON preview and create-only forwards protection without implicit preview", async () => {
  const f = fixture("cli");
  const result = await f.service.checkRegistration(f.input);
  const file = join(root, "definition.json");
  writeFileSync(file, JSON.stringify(f.input));
  const client = new OrbitClient({ url: "http://unused", token: "test", pid: 0 });
  const check = vi.spyOn(client, "benchmarkCheck").mockResolvedValue(result);
  const put = vi
    .spyOn(client, "benchmarkPut")
    .mockResolvedValue({ ...result.definition, createdAt: "", updatedAt: "" });
  const print = vi.fn();
  const run = async (flags: string[]) => {
    const p = new Command();
    registerBench(p, async () => client, print);
    await p.parseAsync(["bench", "add-file", file, ...flags], { from: "user" });
  };
  await run(["--check", "--json"]);
  expect(check).toHaveBeenCalledTimes(1);
  expect(put).not.toHaveBeenCalled();
  expect(print.mock.calls[0]?.slice(0, 2)).toEqual([true, result]);
  expect(print.mock.calls[0]?.[2]()).toContain("No registration or runs created");
  await run(["--create-only"]);
  expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ name: "cli" }), {
    createOnly: true,
  });
  await expect(run(["--check", "--create-only"])).rejects.toThrow("cannot be combined");
  writeFileSync(file, " ".repeat(1024 * 1024 + 1));
  await expect(run(["--check"])).rejects.toThrow("exceeds");
  expect(check).toHaveBeenCalledTimes(1);
});
