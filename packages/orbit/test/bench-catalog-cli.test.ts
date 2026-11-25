import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  formatCatalog,
  parseCatalogFilters,
  registerBenchCatalog,
  selectCatalog,
} from "../src/cli/bench-catalog.ts";
import type { OrbitClient } from "../src/client/index.ts";
import type { BenchCatalog, SupportedBenchmark } from "../src/contracts/index.ts";

const family: SupportedBenchmark = {
  id: "sample",
  name: "Sample benchmark",
  description: "Official multi-track protocol",
  taxonomyGroups: [
    { label: "Browser text", taxonomy: { modalities: ["text"], platforms: ["browser"] } },
    { label: "Desktop images", taxonomy: { modalities: ["image"], platforms: ["desktop"] } },
  ],
  integrations: [{ name: "native", scope: "Independent grader", url: "https://example.com/route" }],
  verification: { detail: "Sampled only", url: "https://example.com/evidence" },
  suites: ["track-one"],
  registrationNames: [],
};
const catalog: BenchCatalog = { supported: [family], entries: [] };

describe("benchmark catalog CLI", () => {
  it("requires one profile to satisfy all fields, with OR inside a field", () => {
    expect(
      selectCatalog(catalog, { filter: ["modalities=image", "platforms=browser"] }).supported,
    ).toEqual([]);
    expect(
      selectCatalog(catalog, {
        filter: ["modalities=image", "modalities=text", "platforms=browser"],
      }).supported,
    ).toHaveLength(1);
  });
  it.each([
    "unknown=text",
    "modalities=unknown",
    "modalities=",
    "=text",
    "modalities=text=extra",
    "modalities= ",
  ])("rejects invalid filter %s", (filter) => {
    expect(() => parseCatalogFilters([filter])).toThrow();
  });
  it("searches words across route, label, suite and protocol text, ignoring case", () => {
    expect(
      selectCatalog(catalog, { search: "OFFICIAL browser grader track-one" }).supported,
    ).toHaveLength(1);
    expect(selectCatalog(catalog, { search: "official missing" }).supported).toEqual([]);
    expect(selectCatalog(catalog, { registered: true }).supported).toEqual([]);
    expect(formatCatalog(selectCatalog(catalog, { family: "missing" }), true)).toBe(
      "no matching benchmark families",
    );
  });
  it("parses the command through the client and preserves the catalog JSON envelope", async () => {
    const command = new Command();
    const benchCatalog = vi.fn().mockResolvedValue(catalog);
    const print = vi.fn();
    registerBenchCatalog(command, async () => ({ benchCatalog }) as unknown as OrbitClient, print);
    await command.parseAsync(["catalog", "sample", "--filter", "platforms=browser", "--json"], {
      from: "user",
    });
    expect(benchCatalog).toHaveBeenCalledOnce();
    expect(print.mock.calls[0]?.slice(0, 2)).toEqual([true, catalog]);
  });
  it("returns only explicitly associated local registrations without implying readiness", () => {
    const entries = ["registered-sample", "custom"].map((name) => ({
      benchmark: { name },
    })) as BenchCatalog["entries"];
    const local: BenchCatalog = {
      supported: [{ ...family, registrationNames: ["registered-sample"] }],
      entries,
    };
    const selected = selectCatalog(local, { registered: true });
    expect(selected.supported).toHaveLength(1);
    expect(selected.entries.map((entry) => entry.benchmark.name)).toEqual(["registered-sample"]);
    expect(formatCatalog(selected, false)).toContain("does not establish resource readiness");
  });
  it("keeps list output compact and includes sources and setup in details", () => {
    expect(formatCatalog(catalog, false)).not.toContain(family.description);
    const detail = formatCatalog(catalog, true);
    expect(detail).toContain(family.description);
    expect(detail).toContain(family.verification.url);
    expect(detail).toContain("orbit bench resources sample");
  });
});
