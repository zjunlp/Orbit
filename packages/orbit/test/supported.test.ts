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
    listingError: null,
    refreshing: false,
    calibrations: [],
    jobs: 0,
    methods: [],
  });
}

it("ships one supported family per benchmark even with no local registrations", () => {
  const supported = supportedBenchmarks([]);
  expect(supported).toHaveLength(63);
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

it("links native RoboTwin and RoboCasa365 setups by frozen environment across profiles", () => {
  const setups = (
    [
      ["fast-vla", "robotwin", "robotwin-aloha-agilex-head-history/1"],
      ["lingbot-va", "robotwin", "robotwin-aloha-agilex-lingbot-va/1"],
      ["diffusion-policy", "robocasa365", "robocasa365-panda-omron-history2/1"],
      ["xiaomi-robotics-1", "robocasa365", "robocasa365-panda-omron-history4-stride2/1"],
    ] as const
  ).map(([name, kind, profile]) => {
    const entry = registration(name, "derived-local", "derived");
    const id = `${kind}-${name}/1`;
    const profileDigest = `sha256:${"a".repeat(64)}`;
    entry.benchmark.config = {
      profileDigest,
      reference: JSON.stringify({ id, environment: { kind }, benchmarkProfile: { id: profile } }),
    };
    entry.capabilities = {
      conditions: { "Profile digest": profileDigest },
      embodied: { profile: id, semanticProfile: { id: profile } },
    } as never;
    return entry;
  });
  const rows = supportedBenchmarks(setups);
  expect(rows.find((row) => row.id === "robotwin")?.registrationNames).toEqual([
    "fast-vla",
    "lingbot-va",
  ]);
  expect(rows.find((row) => row.id === "robocasa365")?.registrationNames).toEqual([
    "diffusion-policy",
    "xiaomi-robotics-1",
  ]);
  const [fastVla] = setups;
  if (!fastVla) throw new Error("missing native setup fixture");
  expect(
    supportedBenchmarks([
      { ...fastVla, identitySource: "label", identity: { id: "local-custom", name: "Custom" } },
      { ...fastVla, capabilities: null },
    ]).every((row) => row.registrationNames.length === 0),
  ).toBe(true);
  const { config } = fastVla.benchmark;
  for (const updated of [
    { ...config, profileDigest: `sha256:${"b".repeat(64)}` },
    { ...config, reference: "{" },
    {
      ...config,
      reference: JSON.stringify({
        id: "robotwin-fast-vla/1",
        environment: { kind: "robotwin" },
        benchmarkProfile: { id: "different-profile/1" },
      }),
    },
  ]) {
    expect(
      supportedBenchmarks([
        { ...fastVla, benchmark: { ...fastVla.benchmark, config: updated } },
      ]).every((row) => row.registrationNames.length === 0),
    ).toBe(true);
  }
});

it("discovers the added embodied families and retains both CHORES registrations", () => {
  const local = [
    ["eb-navigation", "eb-navigation-projected/1"],
    ["hssd-ov", "hssd-ov-stretch-discrete/1"],
    ["libero-mem", "libero-mem-panda-raw/1"],
    ["bigym2", "bigym2-g1-no-pitch/1"],
    ["cliport", "cliport-native-push-rgbd/1"],
  ].map(([family, profile]) => {
    const entry = registration(`local-${family}`, "derived", "derived");
    entry.capabilities = { embodied: { semanticProfile: { id: profile } } } as never;
    return entry;
  });
  for (const variant of ["CHORES-S", "CHORES-L"]) {
    const entry = registration(variant.toLowerCase(), "chores");
    entry.identity.variant = variant;
    local.push(entry);
  }
  const rows = supportedBenchmarks(local);
  for (const id of ["eb-navigation", "hssd-ov", "libero-mem", "bigym2", "cliport"])
    expect(rows.find((row) => row.id === id)?.registrationNames).toEqual([`local-${id}`]);
  const chores = rows.find((row) => row.id === "chores");
  expect(chores?.registrationNames).toEqual(["chores-l", "chores-s"]);
  expect(chores?.suites).toEqual(["CHORES-S", "CHORES-L"]);
});

it("retains profile boundaries and keeps limited integrations visibly limited", () => {
  const rows = supportedBenchmarks([]);
  expect(rows.find((row) => row.id === "robodojo")?.verification.detail).toMatch(/checked/);
  expect(rows.find((row) => row.id === "robolab")?.verification.detail).toMatch(/checked/);
  const miniwob = rows.find((row) => row.id === "miniwob");
  expect(miniwob?.integrations).toHaveLength(2);
  const webvoyager = rows.find((row) => row.id === "webvoyager");
  const live = rows.find((row) => row.id === "online-mind2web");
  expect(webvoyager?.verification.detail).toMatch(/pending/);
  expect(live?.verification.detail).toMatch(/pending/);
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

it("links the implemented BiGym, CLIPort and LIBERO-Mem profiles without inventing versions", () => {
  const profiles = [
    ["bigym2-g1-no-pitch/1", "bigym2"],
    ["bigym2-g1-pitch/1", "bigym2"],
    ["cliport-native-pick-place-rgbd/1", "cliport"],
    ["cliport-native-push-rgbd/1", "cliport"],
    ["libero-mem-panda-raw/1", "libero-mem"],
  ] as const;
  for (const [profile, family] of profiles) {
    const entry = registration("local-policy-benchmark", "derived", "derived");
    entry.capabilities = { embodied: { semanticProfile: { id: profile } } } as never;
    const rows = supportedBenchmarks([entry]);
    expect(rows.filter((row) => row.registrationNames.length).map((row) => row.id)).toEqual([
      family,
    ]);
    entry.capabilities = { embodied: { semanticProfile: { id: `${profile}0` } } } as never;
    expect(supportedBenchmarks([entry]).every((row) => row.registrationNames.length === 0)).toBe(
      true,
    );
  }
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

it("keeps reviewed task subjects and input layouts separate in taxonomy filters", () => {
  const rows = supportedBenchmarks([]);
  const matches = (id: string, filter: Parameters<typeof taxonomyMatches>[1]) =>
    rows
      .find((row) => row.id === id)
      ?.taxonomyGroups.filter((g) => taxonomyMatches(g.taxonomy, filter));
  expect(
    matches("frontierswe-v2", { domains: ["science"], taskTypes: ["implementation"] }),
  ).toHaveLength(1);
  expect(
    matches("frontierswe-v2", { domains: ["science"], taskTypes: ["optimization"] }),
  ).toHaveLength(0);
  expect(matches("robomimic", { modalities: ["image"] })).toHaveLength(1);
  expect(matches("robomimic", { modalities: ["text"] })).toHaveLength(0);
  expect(matches("tau2-bench", { participants: ["simulated-user"] })).toHaveLength(0);
  expect(matches("textarena", { participants: ["opponent"] })).toHaveLength(0);
  expect(matches("libero-mem", { targets: ["memory"] })).toHaveLength(1);
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
