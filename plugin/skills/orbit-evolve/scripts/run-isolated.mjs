// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkChanges,
  instructionEntries,
  MAX_BYTES,
  safePath,
  sha256,
  snapshot,
  writeSnapshot,
} from "./isolated-files.mjs";

/** @typedef {import("../../../../packages/orbit/src/contracts/index.ts").Run} Run
 * @typedef {import("../../../../packages/orbit/src/contracts/index.ts").AuthProfile} AuthProfile
 * @typedef {import("../../../../packages/orbit/src/contracts/index.ts").TrajectoryExportManifest} ExportManifest
 * @typedef {{parent: string, parentRevision: string, parentDigest: string, evolveJob: string,
 * evolveMethod: string, evolveTasks: string, policy: string, out: string, auth: string,
 * model: string, effort: string, image: string, orbit: string[],
 * limits: {changedLines: number, changedBytes: number, editorTokens: number, timeoutMin: number}}} Request
 */
const here = dirname(fileURLToPath(import.meta.url));
/** Skills may be copied independently of the npm package by a plugin manager. */
async function loadContracts() {
  const candidates = [
    new URL("../../../../contracts.mjs", import.meta.url),
    new URL("../../../../packages/orbit/src/contracts/index.ts", import.meta.url),
  ];
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const cli = join(directory, "orbit");
    if (existsSync(cli))
      candidates.push(pathToFileURL(join(dirname(realpathSync(cli)), "contracts.mjs")));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return await import(candidate.href);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(
    "Orbit runtime not found. Run the helper with npm exec --package=@zjunlp/orbit -- node ... or install Orbit on PATH.",
  );
}
/** @type {typeof import("../../../../packages/orbit/src/contracts/index.ts")} */
const contracts = await loadContracts();

/** @param {string} path */
function json(path) {
  assert(
    lstatSync(path).isFile() && lstatSync(path).size <= MAX_BYTES * 2,
    "JSON file too large or not regular",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}
/** @param {string} path @param {unknown} value */
function save(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
/** @param {unknown} value @param {string} [base] @returns {Request} */
export function requestFrom(value, base = process.cwd()) {
  assert(value && typeof value === "object" && !Array.isArray(value), "request object required");
  const r = /** @type {Request} */ (value);
  const paths = ["parent", "evolveTasks", "policy", "out"];
  const strings = [
    ...paths,
    "parentRevision",
    "parentDigest",
    "evolveJob",
    "evolveMethod",
    "auth",
    "model",
    "effort",
    "image",
  ];
  assert(
    Object.keys(r).every((k) => [...strings, "orbit", "limits"].includes(k)),
    "unknown request field",
  );
  for (const key of strings) {
    const v = Reflect.get(r, key);
    assert(
      typeof v === "string" &&
        v.length > 0 &&
        v.length <= 4096 &&
        !Array.from(v).some((c) => c.charCodeAt(0) < 32),
      `invalid ${key}`,
    );
    if (paths.includes(key)) Reflect.set(r, key, resolve(base, v));
  }
  assert(
    /^[a-f0-9]{12}$/.test(r.parentRevision) && /^[a-f0-9]{64}$/.test(r.parentDigest),
    "invalid parent identity",
  );
  assert(
    ["minimal", "low", "medium", "high", "xhigh"].includes(r.effort),
    "unsupported Codex effort",
  );
  r.orbit ??= ["orbit"];
  assert(
    Array.isArray(r.orbit) &&
      r.orbit.length > 0 &&
      r.orbit.every((v) => typeof v === "string" && v.length > 0),
    "orbit must be an argv array",
  );
  assert(
    r.limits &&
      Object.keys(r.limits).sort().join() === "changedBytes,changedLines,editorTokens,timeoutMin",
    "explicit change, token and time limits required",
  );
  for (const n of Object.values(r.limits))
    assert(Number.isSafeInteger(n) && n > 0, "limits must be positive integers");
  assert(
    r.limits.changedBytes <= MAX_BYTES && r.limits.timeoutMin <= 60,
    "editor limits exceed hard bounds",
  );
  return r;
}
/** @param {Request} r @param {string[]} args @param {number[]} [allowed] @param {boolean} [jsonOutput] */
function orbit(r, args, allowed = [0], jsonOutput = true) {
  const [cmd, ...prefix] = r.orbit;
  assert(cmd);
  const p = spawnSync(cmd, [...prefix, ...args], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: MAX_BYTES * 2,
  });
  assert(
    !p.error && p.status !== null && allowed.includes(p.status),
    `orbit ${args.slice(0, 2).join(" ")} failed: ${p.error?.message ?? p.stderr.slice(-2000)}`,
  );
  return jsonOutput ? JSON.parse(p.stdout) : null;
}
/** @param {AuthProfile} profile */
export function checkProfile(profile) {
  assert(
    profile.harness === "codex" && !profile.hostNetwork,
    "V3 requires a Codex profile without host networking",
  );
  assert(
    Object.keys(profile.env).every((key) => /^(https?|all|no)_proxy$/i.test(key)),
    "profile may only add proxy environment variables",
  );
}
/** @param {ExportManifest} manifest @param {Set<string>} tasks @param {Request} r */
export function evidenceTrials(manifest, tasks, r) {
  assert(
    manifest.format === "atif" && manifest.filters.validOnly && manifest.filters.outcome === "fail",
    "valid failed ATIF export required",
  );
  assert(manifest.entries.length > 0, "no valid failed evolve evidence");
  const trials = new Set();
  for (const e of manifest.entries) {
    assert(e.cleanup === "done" && e.contexts.length > 0, "unclean or unbound evidence");
    for (const c of e.contexts) {
      assert(
        c.job === r.evolveJob &&
          c.method === r.evolveMethod &&
          c.revision === r.parentRevision &&
          c.revisionApproximate === false &&
          tasks.has(c.task) &&
          c.phase === "solve" &&
          !c.priorAttempt &&
          c.outcome?.evaluation === "valid" &&
          c.outcome.cleanup === "done",
        "evidence is outside the exact parent evolve trials",
      );
      trials.add(c.trial);
    }
  }
  return [...trials].sort();
}
/** @param {string} root @param {ExportManifest} manifest */
export function verifyExport(root, manifest) {
  const files = snapshot(root).filter((e) => e.body !== null);
  const expected = new Map(manifest.files.map((f) => [safePath(f.path), f]));
  assert(
    expected.size === manifest.files.length && !expected.has("manifest.json"),
    "duplicate export paths",
  );
  assert(
    files.length === expected.size + 1 && files.some((e) => e.path === "manifest.json"),
    "unexpected export files",
  );
  for (const e of files) {
    if (e.path === "manifest.json") continue;
    const f = expected.get(e.path),
      body = Buffer.from(e.body ?? "", "base64");
    assert(f && f.bytes === body.length && f.sha256 === sha256(body), "export integrity mismatch");
  }
  for (const e of manifest.entries) assert(expected.has(e.path), "missing trajectory file");
}
/** @param {import("../../../../packages/orbit/src/contracts/index.ts").MethodRevision | undefined} parent
 * @param {Request} r */
export function checkParent(parent, r) {
  assert(
    parent &&
      !parent.approximate &&
      parent.revision === r.parentRevision &&
      parent.basis.bundleDigest === r.parentDigest,
    "parent identity differs from saved evolve job",
  );
}
/** @param {Request} r */
export function runArgs(r) {
  return [
    "run",
    "--no-project",
    "--image",
    r.image,
    "--auth",
    r.auth,
    "--gpus",
    "0",
    "--cpus",
    "1",
    "--mem",
    "2",
    "--timeout",
    String(r.limits.timeoutMin),
    "--mount",
    `${join(r.out, "input")}:/evolve-input:ro`,
    "--name",
    "isolated instruction evolver",
    "--group",
    "evolution-editor",
    "--json",
    "--",
    "python3",
    "/evolve-input/editor.py",
  ];
}
/** @param {Request} r */
export function submit(r) {
  assert(!existsSync(r.out), "round directory already exists; do not resubmit a round");
  r.out = join(realpathSync(dirname(r.out)), r.out.split("/").at(-1) ?? "");
  assert(!r.out.includes(":"), "round directory cannot contain a colon");
  const rel = relative(realpathSync(r.parent), r.out);
  assert(rel === ".." || rel.startsWith("../"), "round directory must be outside parent");
  const profiles = /** @type {unknown[]} */ (orbit(r, ["auth", "list", "--json"]));
  const profile = profiles
    .map((p) => contracts.AuthProfile.parse(p))
    .find((p) => p.name === r.auth);
  assert(profile, "auth profile missing");
  checkProfile(profile);
  const split = contracts.BenchSplitManifest.parse(
    json(join(dirname(r.evolveTasks), "split.json")),
  );
  const taskBytes = readFileSync(r.evolveTasks);
  assert(taskBytes.length <= contracts.TASK_FILE_MAX_BYTES, "task file too large");
  const taskText = taskBytes.toString("utf8"),
    taskHash = sha256(taskBytes);
  assert(taskHash === split.files.evolve.sha256, "task file must match frozen E1 evolve partition");
  const tasks = new Set(contracts.parseTaskFile(taskText));
  assert(tasks.size === split.files.evolve.count, "evolve count mismatch");
  const source = contracts.BenchJobDetail.parse(orbit(r, ["bench", "show", r.evolveJob, "--json"]));
  checkParent(source.job.revisions[r.evolveMethod], r);
  const parent = instructionEntries(snapshot(r.parent));
  mkdirSync(r.out, { mode: 0o700 });
  const input = join(r.out, "input");
  mkdirSync(input, { mode: 0o700 });
  writeSnapshot(join(input, "parent"), parent);
  const checked = contracts.GateBundleCheck.parse(
    orbit(
      r,
      ["bench", "gate", "check-bundle", join(input, "parent"), "--policy", r.policy, "--json"],
      [0, 2],
    ),
  );
  save(join(r.out, "parent-check.json"), checked);
  assert(
    checked.passed && checked.digest === r.parentDigest,
    "parent digest or static checks failed",
  );
  orbit(r, [
    "trajectory",
    "export",
    "--job",
    r.evolveJob,
    "--method",
    r.evolveMethod,
    "--tasks-file",
    r.evolveTasks,
    "--valid-only",
    "--outcome",
    "fail",
    "--format",
    "atif",
    "--reasoning",
    "none",
    "--sensitive-text",
    "redact",
    "--out",
    join(input, "evidence"),
    "--json",
  ]);
  const manifest = contracts.TrajectoryExportManifest.parse(
    json(join(input, "evidence/manifest.json")),
  );
  const informedBy = evidenceTrials(manifest, tasks, r);
  assert(
    manifest.entries.every((e) =>
      e.contexts.every((c) => c.benchmark === split.benchmark.registration),
    ),
    "evidence benchmark differs from E1 partition",
  );
  verifyExport(join(input, "evidence"), manifest);
  save(join(input, "editor.json"), {
    model: r.model,
    effort: r.effort,
    changedLines: r.limits.changedLines,
    changedBytes: r.limits.changedBytes,
  });
  writeFileSync(
    join(input, "editor.py"),
    readFileSync(join(here, "../assets/isolated-editor.py")),
    { flag: "wx", mode: 0o600 },
  );
  save(join(r.out, "round.json"), {
    request: r,
    informedBy,
    evolveSha256: taskHash,
    inputs: snapshot(input),
    profile,
  });
  const run = contracts.Run.parse(orbit(r, runArgs(r)));
  save(join(r.out, "run.json"), run);
  if (run.spec.hostNetwork || run.spec.project || run.spec.root) {
    orbit(r, ["cancel", run.id], [0], false);
    throw new Error("unsafe Run settings; cancellation requested");
  }
  return {
    run: run.id,
    round: r.out,
    informedBy,
    next: `Wait with orbit wait ${run.id}, then collect this round.`,
  };
}
/** @param {string} path @param {number} [limit] */
async function api(path, limit = MAX_BYTES * 2) {
  const info = json(join(process.env.ORBIT_HOME || join(homedir(), ".orbit"), "daemon.json"));
  const url = new URL(info.url);
  assert(
    url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname),
    "local daemon required",
  );
  const res = await fetch(`${url.origin}/api/v1${path}`, {
    headers: { authorization: `Bearer ${info.token}` },
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  });
  assert(res.ok && res.body, `Orbit API failed (${res.status})`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of res.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("artifact size limit exceeded");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** @param {Run} run @param {Run} submitted @param {Request} r */
export function checkRun(run, submitted, r) {
  assert(
    run.id === submitted.id &&
      run.state === "succeeded" &&
      run.exitCode === 0 &&
      run.cleanup === "done",
    "editor must succeed with confirmed cleanup",
  );
  assert(
    !run.remote &&
      run.spec.backend === "docker" &&
      !run.spec.hostNetwork &&
      !run.spec.root &&
      !run.spec.project &&
      !run.spec.agentBundle,
    "unsafe editor execution",
  );
  assert(JSON.stringify(run.spec) === JSON.stringify(submitted.spec), "Run settings changed");
  assert(
    run.spec.auth === r.auth &&
      run.spec.mounts.length === 1 &&
      run.spec.mounts[0]?.source === join(r.out, "input") &&
      run.spec.mounts[0]?.target === "/evolve-input" &&
      run.spec.mounts[0]?.mode === "ro",
    "unexpected editor mount",
  );
  assert(
    run.tokens &&
      run.tokens.input !== null &&
      run.tokens.output !== null &&
      run.tokens.input + run.tokens.output <= r.limits.editorTokens,
    "editor token use unknown or over budget; retain Run, do not adopt candidate",
  );
}
/** @param {string} round */
export async function collect(round) {
  const record = json(join(round, "round.json")),
    r = requestFrom(record.request);
  assert(realpathSync(round) === r.out, "round path changed");
  assert(
    !existsSync(join(round, "candidate")) && !existsSync(join(round, "result.json")),
    "candidate already collected",
  );
  assert(
    JSON.stringify(snapshot(join(round, "input"))) === JSON.stringify(record.inputs),
    "editor inputs changed",
  );
  const submitted = contracts.Run.parse(json(join(round, "run.json")));
  const run = contracts.Run.parse(orbit(r, ["show", submitted.id, "--json"]).run);
  checkRun(run, submitted, r);
  const entries = instructionEntries(
    await api(`/runs/${encodeURIComponent(run.id)}/files/candidate.json`),
  );
  const changes = checkChanges(
    instructionEntries(snapshot(join(round, "input/parent"))),
    entries,
    r.limits,
  );
  const candidate = join(round, "candidate");
  writeSnapshot(candidate, entries);
  const checked = contracts.GateBundleCheck.parse(
    orbit(r, ["bench", "gate", "check-bundle", candidate, "--policy", r.policy, "--json"], [0, 2]),
  );
  save(join(round, "candidate-check.json"), checked);
  assert(checked.passed, "candidate static checks failed; keep outputs for review");
  const result = {
    run: run.id,
    candidate,
    parent: r.parentRevision,
    informedBy: record.informedBy,
    digest: checked.digest,
    ...changes,
    tokens: run.tokens,
  };
  save(join(round, "result.json"), result);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, path] = process.argv.slice(2);
    assert(
      path && process.argv.length === 4 && ["submit", "collect"].includes(action ?? ""),
      "usage: node run-isolated.mjs submit REQUEST.json | collect ROUND_DIR",
    );
    console.log(
      JSON.stringify(
        action === "submit"
          ? submit(requestFrom(json(resolve(path)), dirname(resolve(path))))
          : await collect(resolve(path)),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "isolated evolver failed");
    process.exitCode = 1;
  }
}
