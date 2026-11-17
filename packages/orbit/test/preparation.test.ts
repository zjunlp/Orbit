import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supportedBenchmarks } from "../src/bench/benchmarks/index.ts";
import {
  preparationBundle,
  preparationDefinition,
  preparationRecipes,
} from "../src/bench/preparation-recipes.ts";
import {
  acquireResource,
  prepareResources,
  validateResource,
} from "../src/bench/preparation-worker.ts";
import { type OrbitClient, tryConnect } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { PreparationInput, PreparationResource } from "../src/contracts/index.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";
import { probeNode } from "../src/resources/probe.ts";

const root = mkdtempSync(join(tmpdir(), "orbit-preparation-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("preparation recipes and input boundaries", () => {
  it("covers every supported family with an executable adapter or original configurator", () => {
    const recipes = preparationRecipes();
    expect(recipes.map((r) => r.id).sort()).toEqual(
      supportedBenchmarks([])
        .map((r) => r.id)
        .sort(),
    );
    const bundle = preparationBundle();
    for (const recipe of recipes) {
      const definition = preparationDefinition(recipe.id);
      expect(recipe.guide).toMatch(/^https:\/\//);
      if (definition.adapter?.includes("/"))
        expect(existsSync(join(bundle, definition.adapter)), recipe.id).toBe(true);
      for (const action of definition.actions ?? [])
        for (const arg of action.argv.filter((arg) => arg.startsWith("{bundle}/")))
          expect(existsSync(arg.replace("{bundle}", bundle)), recipe.id).toBe(true);
      for (const resource of recipe.resources) {
        expect(resource.instructions.length).toBeGreaterThan(20);
        if (resource.access === "authorization") expect(resource.authorizationUrl).toBeTruthy();
      }
    }
  });

  it("does not accept relative paths or credentials embedded in proxy settings", () => {
    expect(PreparationInput.safeParse({ reuse: { source: "relative" } }).success).toBe(false);
    expect(PreparationInput.safeParse({ proxy: "http://user:secret@localhost:8080" }).success).toBe(
      false,
    );
    expect(PreparationInput.safeParse({ tokenEnv: "actual token with spaces" }).success).toBe(
      false,
    );
    expect(
      PreparationInput.safeParse({ proxy: "http://127.0.0.1:17890", tokenEnv: "HF_TOKEN" }).success,
    ).toBe(true);
  });

  it("refuses altered existing source without changing it", async () => {
    const path = join(root, "source");
    mkdirSync(path);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(path, "task.txt"), "original");
    git("add", ".");
    git("commit", "-qm", "fixture");
    const resource = PreparationResource.parse({
      id: "source",
      label: "Fixture",
      kind: "git",
      url: "https://example.invalid/source",
      revision: git("rev-parse", "HEAD"),
      instructions: "Fixture only",
    });
    await validateResource(resource, path);
    writeFileSync(join(path, "task.txt"), "user edit");
    await expect(validateResource(resource, path)).rejects.toThrow("unmodified");
    expect(readFileSync(join(path, "task.txt"), "utf8")).toBe("user edit");
  });

  it("fetches and reuses a pinned tag from a local Git fixture", async () => {
    const source = join(root, "tag-source");
    mkdirSync(source);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    git("tag", "v1.0.0");
    const resource = PreparationResource.parse({
      id: "source",
      label: "Tag fixture",
      kind: "git",
      url: `file://${source}`,
      revision: "v1.0.0",
      instructions: "Fixture only",
    });
    const destination = join(root, "tag-download");
    await acquireResource(resource, destination);
    await acquireResource(resource, destination);
    expect(
      execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe(git("rev-parse", "HEAD"));
  });
});

describe("download validation (local HTTP fixture, not official-source validation)", () => {
  it("verifies bytes, reuses a completed file offline and rejects corrupt input", async () => {
    let requests = 0;
    const body = "fixed public fixture bytes";
    const server = createServer((_req, res) => {
      requests++;
      res.end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const resource = PreparationResource.parse({
      id: "data",
      label: "Fixture data",
      kind: "file",
      url: `http://127.0.0.1:${address.port}/data`,
      sha256: createHash("sha256").update(body).digest("hex"),
      instructions: "Fixture only",
    });
    const destination = join(root, "download", "data");
    try {
      await acquireResource(resource, destination);
      await acquireResource(resource, destination);
      expect(requests).toBe(1);
      writeFileSync(destination, "changed");
      await expect(acquireResource(resource, destination)).rejects.toThrow("SHA-256 mismatch");
      expect(requests).toBe(1);
      expect(readFileSync(destination, "utf8")).toBe("changed");
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it("resumes a partial file using the server's byte range", async () => {
    const body = "a partially downloaded resource";
    const offset = 7;
    let range: string | undefined;
    const server = createServer((req, res) => {
      range = req.headers.range;
      res.writeHead(206, {
        "Content-Range": `bytes ${offset}-${body.length - 1}/${body.length}`,
        "Content-Length": body.length - offset,
      });
      res.end(body.slice(offset));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const destination = join(root, "resumed-file");
    writeFileSync(`${destination}.partial`, body.slice(0, offset));
    try {
      await acquireResource(
        PreparationResource.parse({
          id: "file",
          label: "Range fixture",
          kind: "file",
          url: `http://127.0.0.1:${address.port}/data`,
          sha256: createHash("sha256").update(body).digest("hex"),
          instructions: "Fixture only",
        }),
        destination,
      );
      expect(range).toBe(`bytes=${offset}-`);
      expect(readFileSync(destination, "utf8")).toBe(body);
      expect(existsSync(`${destination}.partial`)).toBe(false);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});

describe("daemon preparation (explicit adapter fixture)", () => {
  const home = join(root, "daemon");
  const paths = orbitPaths({ ORBIT_HOME: home });
  let daemon: StartedDaemon;
  let client: OrbitClient;
  const source = join(root, "prepared");
  const definitionFile = join(root, "benchmark.json");
  beforeAll(async () => {
    mkdirSync(source);
    writeFileSync(join(source, "user-data.txt"), "keep existing files");
    const adapter = join(root, "fixture-adapter.cjs");
    writeFileSync(
      adapter,
      `#!${process.execPath}\nlet input='';process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>{JSON.parse(input);console.log(JSON.stringify({tasks:[{id:'fixture',title:'Explicit development fixture',supported:true,reason:null}]}))});\n`,
    );
    chmodSync(adapter, 0o755);
    writeFileSync(
      definitionFile,
      JSON.stringify({
        name: "fixture-prepared",
        adapter,
        path: source,
        labels: { identity: { id: "textarena", name: "TextArena" } },
      }),
    );
    daemon = await startDaemon(paths, {
      port: 0,
      tickMs: 50,
      self: [process.execPath, fileURLToPath(new URL("../src/bin.ts", import.meta.url))],
      probe: async () => ({
        ...(await probeNode(paths.data, { node: paths.node, gpus: paths.gpus })),
        cpu: { count: 8, load1: 0, busy: 0 },
        memory: { totalGB: 32, availableGB: 32 },
      }),
    });
    const connected = await tryConnect(paths);
    if (!connected) throw new Error("daemon unavailable");
    client = connected;
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("lists all recipes through the shared API and rejects unknown settings", async () => {
    expect((await client.benchResources()).recipes).toHaveLength(supportedBenchmarks([]).length);
    await expect(client.benchPrepare("unknown", {})).rejects.toThrow("Unknown supported benchmark");
    await expect(
      client.benchPrepare("textarena", { values: { command: "touch malicious" } }),
    ).rejects.toThrow("Unknown preparation setting");
  });

  it("imports an existing definition and registers through a real managed process run", async () => {
    const run = await client.benchPrepare("textarena", { registrationFile: definitionFile });
    let status = await client.benchPreparation(run.id);
    for (let i = 0; i < 200 && status.state === "running"; i++) {
      await new Promise((ok) => setTimeout(ok, 50));
      status = await client.benchPreparation(run.id);
    }
    expect(status.pending).toEqual([]);
    expect(status.state).toBe("registered");
    expect(status.run.cleanup).toBe("done");
    expect(status.registrations).toEqual(["fixture-prepared"]);
    expect((await client.benchTasks("fixture-prepared"))[0]?.id).toBe("fixture");
    expect((await client.benchPreparation(run.id)).registrations).toEqual(status.registrations);
    expect(status.input?.registrationFile).toBe(definitionFile);
  }, 20000);

  it("refuses to overwrite a registered configuration, including environment settings", async () => {
    const before = (await client.benchmarks()).find((b) => b.name === "fixture-prepared");
    expect(before).toBeDefined();
    const file = join(root, "conflict.json");
    writeFileSync(file, JSON.stringify({ ...before, env: { CHANGED: "1" } }));
    const run = await client.benchPrepare("textarena", { registrationFile: file });
    let status = await client.benchPreparation(run.id);
    for (let i = 0; i < 200 && status.state === "running"; i++) {
      await new Promise((ok) => setTimeout(ok, 50));
      status = await client.benchPreparation(run.id);
    }
    expect(status.state).toBe("needs_input");
    expect(status.pending.join(" ")).toContain("existing setup was kept");
    expect((await client.benchmarks()).find((b) => b.name === "fixture-prepared")).toEqual(before);
  }, 20000);

  it("protects an existing directory from becoming a preparation workspace", async () => {
    await expect(
      client.benchPrepare("textarena", { directory: source, registrationFile: definitionFile }),
    ).rejects.toThrow("empty download directory");
    expect(existsSync(join(source, ".orbit-preparation.json"))).toBe(false);
    await expect(
      client.benchPrepare("textarena", { directory: preparationBundle() }),
    ).rejects.toThrow("outside the Orbit");
  });

  it("keeps the selected family honest when importing a definition", async () => {
    await expect(
      prepareResources({
        family: "hle",
        directory: join(root, "wrong-family"),
        input: PreparationInput.parse({ registrationFile: definitionFile }),
      }),
    ).rejects.toThrow("not hle");
  });

  it("reports manual inputs without creating a misleading registration", async () => {
    const result = await prepareResources(
      {
        family: "textarena",
        directory: join(root, "manual"),
        input: PreparationInput.parse({}),
      },
      {
        resources: [
          {
            id: "gated",
            label: "Fixture gated dataset",
            kind: "file",
            access: "authorization",
            url: "http://127.0.0.1:1/must-not-download",
            authorizationUrl: "https://example.invalid/access",
            instructions: "Complete official access first",
          },
        ],
        adapter: "harbor",
      },
    );
    expect(result.definitions).toEqual([]);
    expect(result.pending.join(" ")).toContain("https://example.invalid/access");
  });
});
