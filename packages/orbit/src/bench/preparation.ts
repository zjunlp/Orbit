import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OrbitPaths } from "../config/paths.ts";
import {
  type Benchmark,
  BenchmarkInput,
  type PreparationCatalog,
  PreparationInput,
  type PreparationStatus,
  PreparedResources,
  type Run,
  TERMINAL_STATES,
} from "../contracts/index.ts";
import { newId } from "../lib/ids.ts";
import { writePrivateJson } from "../lib/private-json.ts";
import { NotFoundError, type RunService, UserError } from "../runs/service.ts";
import type { Store } from "../store/index.ts";
import type { DatasetRegistry } from "../workspace/datasets.ts";
import { preparationBundle, preparationRecipes } from "./preparation-recipes.ts";

const GROUP = "benchmark-preparation";
const EVENT = "benchmark_preparation";
interface Deps {
  paths: OrbitPaths;
  runs: RunService;
  store: Store;
  datasets: DatasetRegistry;
  self: string[];
  validate: (input: BenchmarkInput) => Promise<BenchmarkInput>;
  commit: (input: BenchmarkInput) => Benchmark;
  registrations: () => Benchmark[];
}

/** Preparation uses Run scheduling, logs, cancellation and recovery; registration stays in the daemon. */
export class BenchmarkPreparation {
  private readonly deps: Deps;
  private readonly finishing = new Map<string, Promise<void>>();
  private submitting = false;
  private stopped = false;

  constructor(deps: Deps) {
    this.deps = deps;
    deps.runs.on("change", ({ run }) => {
      if (
        !this.stopped &&
        run.spec.group === GROUP &&
        run.state === "succeeded" &&
        run.cleanup === "done"
      )
        void this.finish(run);
    });
  }

  catalog(): PreparationCatalog {
    return {
      directory: join(this.deps.paths.data, "bench-resources"),
      recipes: preparationRecipes().map((recipe) => ({
        ...recipe,
        registrationNames: this.deps
          .registrations()
          .filter(
            (b) =>
              b.labels?.identity?.id === recipe.id ||
              (b.labels?.identity?.id === "cua-lite" &&
                (recipe.id === "webvoyager"
                  ? Boolean(b.config.webVoyagerImage)
                  : recipe.id === "online-mind2web" && Boolean(b.config.onlineMind2WebImage))),
          )
          .map((b) => b.name),
      })),
    };
  }

  recover(): void {
    this.stopped = false;
    for (const run of this.deps.store.listRuns({ group: GROUP, limit: 10000 }))
      if (run.state === "succeeded" && run.cleanup === "done") void this.finish(run);
  }

  stop(): void {
    this.stopped = true;
  }

  async submit(family: string, value: unknown): Promise<Run> {
    const recipe = this.catalog().recipes.find((r) => r.id === family);
    if (!recipe) throw new NotFoundError(`Unknown supported benchmark: ${family}`);
    const input = PreparationInput.parse(value);
    const allowedResources = new Set(recipe.resources.map((r) => r.id));
    const allowedFields = new Set(recipe.fields.map((f) => f.id));
    for (const key of Object.keys(input.reuse))
      if (!allowedResources.has(key)) throw new UserError(`Unknown resource: ${key}`);
    for (const key of input.authorized)
      if (!allowedResources.has(key)) throw new UserError(`Unknown resource: ${key}`);
    for (const key of Object.keys(input.values))
      if (!allowedFields.has(key)) throw new UserError(`Unknown preparation setting: ${key}`);
    if (!this.deps.self.length)
      throw new UserError(
        "This daemon cannot launch resource preparation; restart it with the installed Orbit CLI.",
      );
    if (this.submitting) throw new UserError("Another preparation is being submitted; try again.");
    this.submitting = true;
    try {
      const directory = resolve(
        input.directory ?? join(this.deps.paths.data, "bench-resources", family),
      );
      const assets = preparationBundle();
      const bundle = basename(assets) === "bench-assets" ? dirname(dirname(assets)) : assets;
      if (directory === bundle || directory.startsWith(`${bundle}/`))
        throw new UserError(
          "Keep downloaded benchmark resources outside the Orbit installation / source checkout.",
        );
      let ancestor = directory;
      while (!existsSync(ancestor)) ancestor = dirname(ancestor);
      const resolvedAncestor = realpathSync(ancestor);
      if (
        resolvedAncestor === realpathSync(bundle) ||
        resolvedAncestor.startsWith(`${realpathSync(bundle)}/`)
      )
        throw new UserError(
          "The download directory resolves inside the Orbit installation / source checkout.",
        );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const canonical = realpathSync(directory);
      if (
        this.deps.store
          .listRuns({ group: GROUP, limit: 10000 })
          .some(
            (r) =>
              (!TERMINAL_STATES.includes(r.state) || r.cleanup === "pending") &&
              r.spec.tags.preparationDirectory === canonical,
          )
      )
        throw new UserError(
          "Preparation is already running in this directory; inspect or cancel that run first.",
        );
      const marker = join(canonical, ".orbit-preparation.json");
      if (existsSync(marker)) {
        if (JSON.parse(readFileSync(marker, "utf8")).family !== family)
          throw new UserError(
            "This directory belongs to another benchmark preparation. Choose a separate download directory.",
          );
      } else {
        if (readdirSync(canonical).length)
          throw new UserError(
            "Choose an empty download directory. To reuse existing data, supply its path in a resource field instead.",
          );
        writePrivateJson(marker, { family });
      }
      const plan = join(this.deps.paths.bench, `preparation-${newId()}.json`);
      writePrivateJson(plan, { family, directory: canonical, input });
      return await this.deps.runs.submit({
        backend: "process",
        command: [...this.deps.self, "__prepare", plan],
        snapshot: false,
        cwd: canonical,
        name: `Prepare ${recipe.name}`,
        group: GROUP,
        resources: { cpus: 2, memGB: 4, gpus: 0, node: this.deps.runs.nodeName },
        timeoutMin: 1440,
        tags: { preparationFamily: family, preparationDirectory: canonical },
        env: input.proxy
          ? { http_proxy: input.proxy, https_proxy: input.proxy, no_proxy: "localhost,127.0.0.1" }
          : {},
        passEnv: input.tokenEnv ? [input.tokenEnv] : [],
      });
    } finally {
      this.submitting = false;
    }
  }

  private outcome(id: string): Omit<PreparationStatus, "run" | "family"> | undefined {
    const event = this.deps.store.events(id).findLast((e) => e.kind === EVENT);
    return event
      ? (JSON.parse(event.message) as Omit<PreparationStatus, "run" | "family">)
      : undefined;
  }

  async status(id: string): Promise<PreparationStatus> {
    const run = this.deps.store.getRun(id);
    if (!run || run.spec.group !== GROUP)
      throw new NotFoundError(`Preparation run not found: ${id}`);
    if (run.state === "succeeded" && run.cleanup === "done") await this.finish(run);
    const errorFile = join(this.deps.runs.dirs(run.id).output, "preparation-error.json");
    let error = run.reason;
    if (run.state === "failed" && existsSync(errorFile)) {
      try {
        error = JSON.parse(readFileSync(errorFile, "utf8")).message ?? error;
      } catch {
        /* Interrupted error write: keep the run reason. */
      }
    }
    const planFile = run.spec.command.at(-1);
    const input =
      planFile?.startsWith(`${this.deps.paths.bench}/preparation-`) && existsSync(planFile)
        ? PreparationInput.parse(JSON.parse(readFileSync(planFile, "utf8")).input)
        : undefined;
    return {
      run,
      input,
      family: run.spec.tags.preparationFamily ?? "",
      ...(this.outcome(id) ?? {
        state:
          run.state === "cancelled"
            ? "cancelled"
            : TERMINAL_STATES.includes(run.state) && run.cleanup !== "pending"
              ? "failed"
              : "running",
        registrations: [],
        resources: {},
        pending: error ? [error] : [],
      }),
    };
  }

  private finish(run: Run): Promise<void> {
    const current = this.finishing.get(run.id);
    if (current) return current;
    if (this.outcome(run.id)) return Promise.resolve();
    const promise = this.registerResult(run).finally(() => this.finishing.delete(run.id));
    this.finishing.set(run.id, promise);
    return promise;
  }

  private async registerResult(run: Run): Promise<void> {
    const outcome: Omit<PreparationStatus, "run" | "family"> = {
      state: "needs_input",
      registrations: [],
      resources: {},
      pending: [],
    };
    try {
      const resultFile = join(this.deps.runs.dirs(run.id).output, "preparation.json");
      if (!existsSync(resultFile))
        throw new Error("Preparation ended without a resource manifest; inspect its run log.");
      const result = PreparedResources.parse(JSON.parse(readFileSync(resultFile, "utf8")));
      outcome.resources = result.resources;
      outcome.pending = result.pending;
      if (!result.pending.length) {
        const validated = [];
        for (const definition of result.definitions)
          validated.push(BenchmarkInput.parse(await this.deps.validate(definition)));
        if (this.stopped) return;
        // Precheck every name before changing any registration. Never replace a different setup.
        const names = new Set<string>();
        for (const definition of validated) {
          if (names.has(definition.name))
            throw new Error(`Duplicate registration name: ${definition.name}`);
          names.add(definition.name);
          const existing = this.deps.registrations().find((b) => b.name === definition.name);
          if (existing && !isDeepStrictEqual(BenchmarkInput.parse(existing), definition))
            throw new Error(
              `Registration ${definition.name} already exists with different settings. Choose another name; the existing setup was kept.`,
            );
        }
        for (const dataset of result.datasets) {
          if (!statSync(dataset.path, { throwIfNoEntry: false }))
            throw new Error(`Dataset path does not exist: ${dataset.path}`);
          const existing = this.deps.datasets.get(dataset.name);
          if (existing && existing.path !== dataset.path)
            throw new Error(
              `Dataset ${dataset.name} already points elsewhere; its existing path was kept.`,
            );
        }
        for (const definition of validated) {
          if (!definition.config.reference) continue;
          const reference = JSON.parse(definition.config.reference) as {
            environment?: { assets?: { dataset?: string } };
          };
          const name = reference.environment?.assets?.dataset;
          if (
            name &&
            !this.deps.datasets.get(name) &&
            !result.datasets.some((d) => d.name === name)
          )
            throw new Error(
              `Register the existing ${name} asset directory with orbit data add before importing this definition.`,
            );
        }
        // No await between this final conflict check and commit: API requests cannot interleave.
        for (const dataset of result.datasets) this.deps.datasets.put(dataset);
        for (const definition of validated)
          outcome.registrations.push(
            (
              this.deps.registrations().find((b) => b.name === definition.name) ??
              this.deps.commit(definition)
            ).name,
          );
        outcome.state = outcome.registrations.length ? "registered" : "needs_input";
        if (!outcome.registrations.length)
          outcome.pending.push(
            "No registration was produced; provide the inputs listed in the resource recipe.",
          );
      }
    } catch (e) {
      outcome.pending.push((e as Error).message);
    }
    if (!this.stopped) this.deps.store.addEvent(run.id, EVENT, JSON.stringify(outcome));
  }
}
