import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  BenchmarkInput,
  PreparationInput,
  type PreparationResource,
  PreparedResources,
} from "../contracts/index.ts";
import { exec } from "../lib/exec.ts";
import { preparationBundle, preparationDefinition } from "./preparation-recipes.ts";

export const PreparationPlan = z.object({
  family: z.string(),
  directory: z.string(),
  input: PreparationInput,
});
export type PreparationPlan = z.infer<typeof PreparationPlan>;

export async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function command(
  argv: string[],
  opts: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {},
): Promise<string> {
  return await new Promise<string>((ok, fail) => {
    let output = "";
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.stdin ? "pipe" : "ignore", opts.capture ? "pipe" : "inherit", "inherit"],
    });
    child.on("error", (e) => fail(new Error(`${argv[0]} could not start: ${e.message}`)));
    child.on("close", (code, signal) =>
      code === 0
        ? ok(output.trim())
        : fail(new Error(`${argv[0]} failed (${signal ?? code}); see the preparation log above.`)),
    );
    child.stdin?.end(opts.stdin);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1024 * 1024) child.kill();
    });
  });
}

export async function validateResource(resource: PreparationResource, path: string): Promise<void> {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`${resource.label}: local path does not exist: ${path}`);
  if (resource.kind === "git") {
    if (!st.isDirectory()) throw new Error(`${resource.label}: expected a Git checkout`);
    const git = async (...args: string[]) => {
      const result = await exec("git", ["-C", path, ...args]);
      if (result.code !== 0)
        throw new Error(
          `${resource.label}: expected an unmodified checkout at ${resource.revision}. ${result.stderr.trim()}`,
        );
      return result.stdout.trim();
    };
    const actual = await git("rev-parse", "HEAD");
    if (resource.revision && resource.revision !== "HEAD") {
      const expected = await git("rev-parse", `${resource.revision}^{commit}`);
      if (actual !== expected)
        throw new Error(
          `${resource.label}: expected ${resource.revision}, found ${actual}; existing files were left untouched.`,
        );
    }
    await git("diff", "--exit-code", "HEAD", "--");
    if (resource.submodules !== false) {
      const submodules = await git("submodule", "status", "--recursive");
      if (submodules.split("\n").some((line) => /^[-+U]/.test(line)))
        throw new Error(
          `${resource.label}: initialize its pinned submodules before reusing this checkout`,
        );
    }
  }
  if (resource.kind === "file" && !st.isFile())
    throw new Error(`${resource.label}: expected a regular file`);
  if (resource.sha256 && (await fileHash(path)) !== resource.sha256)
    throw new Error(
      `${resource.label}: SHA-256 mismatch; the existing file was left untouched: ${path}`,
    );
}

export async function acquireResource(
  resource: PreparationResource,
  destination: string,
  token?: string,
): Promise<string> {
  if (existsSync(destination)) {
    await validateResource(resource, destination);
    console.log(`Reusing ${resource.label}: ${destination}`);
    return destination;
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  console.log(`Downloading ${resource.label} from ${resource.url}`);
  const partial = `${destination}.partial`;
  if (lstatSync(partial, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`Refusing a symlink at the partial download path: ${partial}`);
  if (resource.kind === "git") {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (!existsSync(join(partial, ".git"))) {
      if (existsSync(partial) && readdirSync(partial).length)
        throw new Error(`Partial download is not an Orbit Git checkout: ${partial}`);
      await command(["git", "init", partial], { env });
      await command(["git", "-C", partial, "remote", "add", "origin", resource.url], { env });
    }
    const origin = await exec("git", ["-C", partial, "remote", "get-url", "origin"]);
    if (origin.code !== 0 || origin.stdout.trim() !== resource.url)
      throw new Error(
        `Partial checkout has a different origin; choose a fresh download directory: ${partial}`,
      );
    const revision = resource.revision ?? "HEAD";
    await command(
      [
        "git",
        "-C",
        partial,
        "fetch",
        "--depth",
        "1",
        "origin",
        ...(revision.startsWith("v") ? ["tag", revision] : [revision]),
      ],
      { env },
    );
    await command(["git", "-C", partial, "checkout", "--detach", "FETCH_HEAD"], { env });
    if (resource.submodules !== false)
      await command(
        ["git", "-C", partial, "submodule", "update", "--init", "--recursive", "--depth", "1"],
        { env },
      );
  } else if (resource.kind === "file") {
    await command(
      [
        "curl",
        "--fail",
        "--location",
        "--retry",
        "2",
        "--connect-timeout",
        "30",
        "--continue-at",
        "-",
        "--output",
        partial,
        ...(token ? ["--header", "@-"] : []),
        resource.url,
      ],
      { stdin: token ? `Authorization: Bearer ${token}\n` : undefined },
    );
    if (resource.sha256 && (await fileHash(partial)) !== resource.sha256) {
      rmSync(partial);
      throw new Error(`${resource.label}: downloaded SHA-256 mismatch; no resource was installed.`);
    }
  } else if (resource.kind === "huggingface") {
    const url = new URL(resource.url);
    const dataset = url.pathname.startsWith("/datasets/");
    const repo = url.pathname.replace(/^\/(datasets\/)?/, "");
    await command(
      [
        "hf",
        "download",
        repo,
        "--repo-type",
        dataset ? "dataset" : "model",
        "--revision",
        resource.revision ?? "main",
        "--local-dir",
        partial,
        ...(resource.includes ?? []).flatMap((name) => ["--include", name]),
      ],
      { env: { ...process.env, ...(token ? { HF_TOKEN: token } : {}) } },
    );
  } else
    throw new Error(
      `${resource.label}: follow the official access instructions and supply its local path.`,
    );
  await validateResource(resource, partial);
  renameSync(partial, destination);
  return destination;
}

function expand(value: string, variables: Record<string, string>): string {
  return value.replace(/\{([\w-]+)\}/g, (_whole, key: string) => {
    if (!variables[key]) throw new Error(`Missing preparation input: ${key}`);
    return variables[key] as string;
  });
}
function missing(argv: string[], variables: Record<string, string>): string[] {
  return [
    ...new Set(
      argv
        .flatMap((value) => [...value.matchAll(/\{([\w-]+)\}/g)].map((m) => m[1] as string))
        .filter((key) => !variables[key]),
    ),
  ];
}
function generatedFiles(root: string, depth = 0): string[] {
  if (!existsSync(root) || depth > 3) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isFile() && entry.name === "benchmark.json"
      ? [join(root, entry.name)]
      : entry.isDirectory()
        ? generatedFiles(join(root, entry.name), depth + 1)
        : [],
  );
}

export async function prepareResources(
  plan: PreparationPlan,
  definition = preparationDefinition(plan.family),
): Promise<PreparedResources> {
  const { family, directory, input } = plan;
  const importFile = input.registrationFile ?? input.values.registration;
  const resources: Record<string, string> = {};
  const pending: string[] = [];
  const variables: Record<string, string> = {
    bundle: preparationBundle(),
    directory,
    generated: join(directory, "registrations"),
    uid: String(userInfo().uid),
    gid: String(userInfo().gid),
    imageTag: `orbit/prepare-${family}:${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`,
  };
  for (const f of definition.fields ?? [])
    if (f.default) variables[f.id] = expand(f.default, variables);
  Object.assign(variables, input.values);
  if (!importFile)
    for (const f of definition.fields ?? []) {
      const value = input.values[f.id];
      if (value && f.kind === "path" && (!value.startsWith("/") || !existsSync(value)))
        throw new Error(`${f.label}: use an existing absolute path on this machine: ${value}`);
      if (value && f.id.endsWith("Url")) {
        const url = new URL(value);
        if (url.username || url.password)
          throw new Error(`${f.label}: credentials must not appear in URLs`);
      }
    }
  const token = input.tokenEnv ? process.env[input.tokenEnv] : undefined;
  if (token && /[\r\n]/.test(token)) throw new Error("Download token contains a line break");
  for (const resource of importFile ? [] : definition.resources) {
    const supplied = input.reuse[resource.id];
    if (supplied) {
      await validateResource(resource, supplied);
      resources[resource.id] = resolve(supplied);
      console.log(`Using existing ${resource.label}: ${supplied}`);
    } else if (
      resource.kind === "manual" ||
      (resource.access === "authorization" && !input.authorized.includes(resource.id))
    ) {
      pending.push(
        `${resource.label}: ${resource.instructions} ${resource.authorizationUrl ?? resource.url}`,
      );
    } else {
      resources[resource.id] = await acquireResource(
        resource,
        join(
          directory,
          "resources",
          resource.id,
          ...(resource.filename ? [resource.filename] : []),
        ),
        resource.access === "authorization" ? token : undefined,
      );
    }
  }
  Object.assign(variables, resources);
  if (!importFile) {
    mkdirSync(join(directory, "data"), { recursive: true, mode: 0o700 });
    for (const action of definition.actions ?? []) {
      if (action.unless && variables[action.unless]) continue;
      const absent = missing([...action.argv, ...(action.cwd ? [action.cwd] : [])], variables);
      if (absent.length) {
        pending.push(`${action.label}: supply ${absent.join(", ")}`);
        continue;
      }
      console.log(action.label);
      const argv = action.argv.map((arg) => expand(arg, variables));
      const stamp = join(
        directory,
        "actions",
        `${createHash("sha256").update(JSON.stringify(argv)).digest("hex")}.json`,
      );
      const output = action.output ? expand(action.output, variables) : undefined;
      if (output && existsSync(output) && existsSync(stamp)) {
        console.log(`Reusing prepared files: ${output}`);
        continue;
      }
      if (argv[0] === "docker" && argv[1] === "build" && input.proxy)
        argv.splice(
          2,
          0,
          "--network",
          "host",
          "--build-arg",
          "HTTP_PROXY",
          "--build-arg",
          "HTTPS_PROXY",
        );
      const captured = await command(argv, {
        cwd: action.cwd ? expand(action.cwd, variables) : directory,
        capture: Boolean(action.capture),
        env: {
          ...process.env,
          ...(input.proxy ? { HTTP_PROXY: input.proxy, HTTPS_PROXY: input.proxy } : {}),
        },
      });
      if (action.capture) variables[action.capture] = captured;
      if (output) {
        mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 });
        writeFileSync(stamp, JSON.stringify({ output }), { mode: 0o600 });
      }
    }
    for (const f of definition.fields ?? []) {
      const value = variables[f.id];
      if (f.required && !value) pending.push(`${f.label}: ${f.help}`);
      if (value && f.kind === "path" && (!value.startsWith("/") || !existsSync(value)))
        throw new Error(`${f.label}: use an existing absolute path on this machine: ${value}`);
    }
    for (const [key, path] of Object.entries(definition.hashes ?? {}))
      if (!missing([path], variables).length && existsSync(expand(path, variables)))
        variables[key] = await fileHash(expand(path, variables));
  }
  const definitions: PreparedResources["definitions"] = [];
  if (importFile) {
    const file = resolve(importFile);
    definitions.push(BenchmarkInput.parse(JSON.parse(readFileSync(file, "utf8"))));
    // A complete user-supplied definition is independently checked by its original adapter.
    pending.length = 0;
  } else if (!pending.length && definition.generated) {
    for (const file of generatedFiles(variables.generated as string))
      definitions.push(BenchmarkInput.parse(JSON.parse(readFileSync(file, "utf8"))));
    if (!definitions.length)
      pending.push(
        "No benchmark registration was generated. Follow the linked setup guide and import its benchmark.json.",
      );
  } else if (!pending.length && definition.adapter) {
    let path = definition.adapter;
    if (path.includes("/")) {
      path = join(variables.bundle as string, path);
      if (path.endsWith(".ts") && existsSync(path.replace(/\.ts$/, ".mjs")))
        path = path.replace(/\.ts$/, ".mjs");
    }
    definitions.push(
      BenchmarkInput.parse({
        name: input.name ?? family,
        adapter: path,
        path: expand(definition.path ?? "{source}", variables),
        config: Object.fromEntries(
          Object.entries(definition.config ?? {}).map(([key, value]) => [
            key,
            expand(value, variables),
          ]),
        ),
        passEnv: definition.passEnv ?? [],
        ...(path.includes("/") && existsSync(join(dirname(path), "resources.json"))
          ? { resources: join(dirname(path), "resources.json") }
          : {}),
      }),
    );
  }
  if (input.name && definitions.length > 1)
    throw new Error(
      "This recipe generates multiple suites; omit --name to preserve their distinct names.",
    );
  for (const registration of definitions) {
    if (input.name) registration.name = input.name;
    const identity = definition.identity ?? { id: family, name: family };
    if (registration.labels?.identity && registration.labels.identity.id !== identity.id)
      throw new Error(
        `Imported registration identifies ${registration.labels.identity.id}, not ${identity.id}`,
      );
    if (importFile && !registration.labels?.identity)
      throw new Error(
        "Imported definitions must declare labels.identity.id matching the selected benchmark. Add that identity to your definition, or use orbit bench add-file for an unclassified setup.",
      );
    registration.labels = {
      ...registration.labels,
      identity: {
        ...registration.labels?.identity,
        id: identity.id,
        name: registration.labels?.identity?.name ?? identity.name,
      },
    };
  }
  const datasets: PreparedResources["datasets"] = [];
  for (const registration of definitions) {
    const raw = registration.config.reference;
    if (!raw) continue;
    const reference = JSON.parse(raw) as { environment?: { assets?: { dataset?: string } } };
    const name = reference.environment?.assets?.dataset;
    const path = variables.assets ?? variables.data;
    if (name && path && !datasets.some((d) => d.name === name)) datasets.push({ name, path });
  }
  for (const [name, value] of Object.entries(definition.datasets ?? {}))
    if (!missing([value], variables).length)
      datasets.push({ name, path: expand(value, variables) });
  return PreparedResources.parse({
    resources,
    definitions,
    datasets,
    pending: [...new Set(pending)],
  });
}

export async function preparationMain(file: string): Promise<void> {
  try {
    const plan = PreparationPlan.parse(JSON.parse(readFileSync(file, "utf8")));
    const output = process.env.ORBIT_OUTPUT;
    if (!output) throw new Error("Resource preparation must run through the Orbit daemon.");
    const result = await prepareResources(plan);
    writeFileSync(join(output, "preparation.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    for (const item of result.pending) console.log(`Action needed: ${item}`);
    console.log(
      result.pending.length
        ? "Downloads retained. Supply the missing inputs and run preparation again."
        : "Resources prepared; the daemon will validate and register the benchmark.",
    );
  } catch (e) {
    console.error(`Preparation failed: ${(e as Error).message}`);
    if (process.env.ORBIT_OUTPUT)
      writeFileSync(
        join(process.env.ORBIT_OUTPUT, "preparation-error.json"),
        JSON.stringify({ message: (e as Error).message }),
        { mode: 0o600 },
      );
    process.exitCode = 1;
  }
}
