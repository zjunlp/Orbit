import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { supportedBenchmarks } from "../src/bench/benchmarks/index.ts";
import {
  Benchmark,
  CatalogEntry,
  SupportedBenchmark,
  taxonomyMatches,
} from "../src/contracts/index.ts";

function registration(
  name: string,
  id: string,
  source: CatalogEntry["identitySource"] = "adapter",
) {
  return CatalogEntry.parse({
    benchmark: Benchmark.parse({
      name,
      adapter: "manifest",
      path: "/fixture",
      createdAt: "",
      updatedAt: "",
    }),
    identity: { id, name: id },
    identitySource: source,
    listing: null,
    capabilities: null,
    domains: [],
    tags: [],
    listingError: null,
    refreshing: false,
    calibrations: [],
    jobs: 0,
    methods: [],
    fidelity: "experimental",
  });
}

it("ships one supported family per benchmark even with no local registrations", () => {
  const supported = supportedBenchmarks([]);
  expect(supported).toHaveLength(39);
  expect(new Set(supported.map((row) => row.id)).size).toBe(supported.length);
  expect(supported.every((row) => row.registrationNames.length === 0)).toBe(true);
  expect(
    supported.some((row) => ["harbor", "browsergym", "cua-lite", "vla-eval"].includes(row.id)),
  ).toBe(false);
  for (const row of supported) {
    expect(SupportedBenchmark.safeParse(row).success).toBe(true);
    for (const url of [...row.integrations.map((item) => item.url), row.verification.url]) {
      const path = url.replace("https://github.com/zjunlp/Orbit/blob/main/", "");
      expect(existsSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url))), path).toBe(
        true,
      );
    }
  }
});

it("groups explicit identities without changing the support facts or inventing name matches", () => {
  const first = registration("asi-run-a", "asi-bench");
  first.jobs = 90;
  first.fidelity = "calibrated";
  first.taxonomy = { domains: ["finance"] };
  const second = registration("asi-run-b", "asi-bench", "label");
  const misleadingName = registration("libero", "derived-local", "derived");
  const entries = supportedBenchmarks([first, second, misleadingName]);
  const asi = entries.filter((row) => row.id === "asi-bench");
  expect(asi).toHaveLength(1);
  expect(asi[0]?.registrationNames).toEqual(["asi-run-a", "asi-run-b"]);
  expect({ ...asi[0], registrationNames: [] }).toEqual(
    supportedBenchmarks([]).find((row) => row.id === "asi-bench"),
  );
  expect(entries.find((row) => row.id === "libero")?.registrationNames).toEqual([]);
  expect(asi[0]).not.toHaveProperty("jobs");
  expect(asi[0]).not.toHaveProperty("calibrations");
  expect(asi[0]).not.toHaveProperty("fidelity");
});

it("links known built-in adapters and exact native semantic profiles only", () => {
  const asi = registration("any-local-name", "derived-asi", "derived");
  asi.benchmark.adapter = "asi";
  const native = registration("local-profile", "derived-native", "derived");
  native.capabilities = { embodied: { semanticProfile: { id: "libero-panda-raw/1" } } } as never;
  const unknown = registration("libero-other", "derived-unknown", "derived");
  unknown.capabilities = { embodied: { semanticProfile: { id: "libero-unknown/99" } } } as never;
  const renamed = {
    ...native,
    identitySource: "label" as const,
    identity: { id: "custom-benchmark", name: "Custom benchmark" },
  };
  const rows = supportedBenchmarks([asi, native, unknown, renamed]);
  expect(rows.find((row) => row.id === "asi-bench")?.registrationNames).toEqual(["any-local-name"]);
  expect(rows.find((row) => row.id === "libero")?.registrationNames).toEqual(["local-profile"]);
  native.capabilities = { embodied: { semanticProfile: { id: "constructor" } } } as never;
  expect(supportedBenchmarks([native]).every((row) => row.registrationNames.length === 0)).toBe(
    true,
  );
});

it("retains profile boundaries and keeps limited integrations visibly limited", () => {
  const rows = supportedBenchmarks([]);
  expect(rows.find((row) => row.id === "robodojo")?.verification.level).toBe("sample-checked");
  expect(rows.find((row) => row.id === "robolab")?.verification.level).toBe("sample-checked");
  const miniwob = rows.find((row) => row.id === "miniwob");
  expect(miniwob?.integrations).toHaveLength(2);
  const webvoyager = rows.find((row) => row.id === "webvoyager");
  const live = rows.find((row) => row.id === "online-mind2web");
  expect(webvoyager?.verification.level).toBe("pending-calibration");
  expect(live?.verification.level).toBe("pending-calibration");
  expect(
    webvoyager?.taxonomyGroups.some((g) => taxonomyMatches(g.taxonomy, { world: ["live"] })),
  ).toBe(false);
  expect(
    live?.taxonomyGroups.some((g) =>
      taxonomyMatches(g.taxonomy, { world: ["live"], interfaces: ["gui"] }),
    ),
  ).toBe(true);
  expect(rows.find((row) => row.id === "tau2-bench")?.integrations[0]?.scope).toContain("only");
  expect(
    SupportedBenchmark.safeParse({
      ...miniwob,
      taxonomyGroups: [{ label: "Invalid", taxonomy: { domains: ["gui"] } }],
    }).success,
  ).toBe(false);
  if (miniwob) miniwob.taxonomyGroups[0]?.taxonomy.interfaces?.push("terminal");
  expect(
    supportedBenchmarks([]).find((row) => row.id === "miniwob")?.taxonomyGroups[0]?.taxonomy
      .interfaces,
  ).toEqual(["gui"]);
});

it("links collection registrations only to explicitly listed runnable benchmark suites", () => {
  const collection = registration("local-browser-setup", "cua-lite");
  collection.listing = {
    at: "",
    capabilities: null,
    metrics: [],
    official: null,
    oracleTasks: null,
    coverage: {
      total: 5,
      supported: 2,
      reasons: [],
      suites: [
        { suite: "browsergym.miniwob", total: 1, supported: 1 },
        { suite: "webharbor.webvoyager", total: 1, supported: 0 },
        { suite: "online_mind2web", total: 1, supported: 1 },
        { suite: "browsergym.webarena", total: 1, supported: 0 },
        { suite: "constructor", total: 1, supported: 0 },
      ],
    },
  };
  const rows = supportedBenchmarks([collection]);
  expect(rows.filter((row) => row.registrationNames.length).map((row) => row.id)).toEqual([
    "miniwob",
    "online-mind2web",
  ]);
  collection.listing = null;
  expect(supportedBenchmarks([collection]).every((row) => row.registrationNames.length === 0)).toBe(
    true,
  );
});

it("keeps embodied harness benchmark identities and learning conditions separate", () => {
  const rows = supportedBenchmarks([]);
  const harnesses = ["rle-bench", "embodied-clbench", "embodiedlab"].map((id) =>
    rows.find((row) => row.id === id),
  );
  expect(harnesses.every(Boolean)).toBe(true);
  expect(
    harnesses.every((row) => row?.integrations.every((route) => !route.name.includes("Policy"))),
  ).toBe(true);
  const clbench = harnesses[1];
  expect(
    clbench?.taxonomyGroups.filter((g) => taxonomyMatches(g.taxonomy, { targets: ["memory"] })),
  ).toHaveLength(1);
  expect(clbench?.integrations[0]?.scope).toContain("unsupported");
  expect(harnesses[2]?.integrations[0]?.scope).toContain("T0");
});
