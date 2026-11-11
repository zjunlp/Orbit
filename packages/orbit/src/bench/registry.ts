// Registered benchmark checkouts in one JSON file written only by the daemon. Entries hold paths
// and non-secret settings; `passEnv` names variables read from the daemon environment at launch.
import { readFileSync, statSync } from "node:fs";
import {
  Benchmark,
  BenchmarkInput,
  type BenchmarkInput as BenchmarkInputT,
} from "../contracts/index.ts";
import { nowIso } from "../lib/ids.ts";
import { writePrivateJson } from "../lib/private-json.ts";
import { legacyTaxonomy } from "./catalog.ts";

/**
 * Entries written by older versions: adapter settings before they moved into `config` (asi
 * `python`, `instances`), and label `domains` before the taxonomy (kept as taxonomy domains).
 */
function upgrade(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const { python, instances, ...rest } = v as Record<string, unknown> & {
    config?: object;
    labels?: { domains?: unknown; taxonomy?: { domains?: unknown } };
  };
  const old = Object.entries({ python, instances }).filter(([, x]) => typeof x === "string");
  const out = old.length
    ? { ...rest, config: { ...Object.fromEntries(old), ...rest.config } }
    : rest;
  const labels = rest.labels;
  if (!labels || !Array.isArray(labels.domains)) return out;
  const { domains, ...kept } = labels;
  const words = domains.filter((d): d is string => typeof d === "string");
  const taxonomy =
    labels.taxonomy?.domains === undefined ? legacyTaxonomy(words, true) : { domains: undefined };
  return {
    ...out,
    labels: {
      ...kept,
      ...(taxonomy.domains ? { taxonomy: { ...labels.taxonomy, domains: taxonomy.domains } } : {}),
    },
  };
}

export class BenchmarkRegistry {
  private readonly file: string;
  private cached: { version: string; benchmarks: Benchmark[] } | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private read(): Benchmark[] {
    const stat = statSync(this.file, { bigint: true, throwIfNoEntry: false });
    if (!stat) {
      this.cached = null;
      return [];
    }
    const version = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.size}`;
    if (this.cached?.version === version) return this.cached.benchmarks;
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as { benchmarks?: unknown[] };
    const benchmarks = (raw.benchmarks ?? []).map((b) => Benchmark.parse(upgrade(b)));
    this.cached = { version, benchmarks };
    return benchmarks;
  }

  private write(all: Benchmark[]): void {
    writePrivateJson(this.file, { version: 1, benchmarks: all });
    this.cached = null;
  }

  list(): Benchmark[] {
    return structuredClone(this.read());
  }

  get(name: string): Benchmark | null {
    return structuredClone(this.read().find((b) => b.name === name) ?? null);
  }

  put(input: BenchmarkInputT): Benchmark {
    const p = BenchmarkInput.parse(input);
    const all = this.read();
    const old = all.find((b) => b.name === p.name);
    const now = nowIso();
    const b: Benchmark = { ...p, createdAt: old?.createdAt ?? now, updatedAt: now };
    this.write(
      [...all.filter((x) => x.name !== p.name), b].sort((x, y) => x.name.localeCompare(y.name)),
    );
    return b;
  }

  remove(name: string): boolean {
    const all = this.read();
    const rest = all.filter((b) => b.name !== name);
    if (rest.length === all.length) return false;
    this.write(rest);
    return true;
  }
}
