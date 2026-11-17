import { resolve } from "node:path";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import type { PreparationRecipe } from "../contracts/index.ts";
import type { Print } from "./auth.ts";
import { kv } from "./options.ts";

export function formatRecipe(recipe: PreparationRecipe): string {
  return [
    recipe.name,
    recipe.description,
    `Guide: ${recipe.guide}`,
    ...recipe.resources.flatMap((r) => [
      `\n${r.id}: ${r.label} (${r.access}; ${r.kind})`,
      `  ${r.url}${r.revision ? ` @ ${r.revision}` : ""}`,
      `  ${r.instructions}`,
      ...(r.access === "authorization"
        ? [
            `  Access / license: ${r.authorizationUrl ?? r.url}`,
            ...(r.kind !== "manual"
              ? [`  After access is granted: --authorized ${r.id} --token-env TOKEN_VARIABLE_NAME`]
              : []),
          ]
        : []),
      `  Reuse: --reuse ${r.id}=/absolute/path`,
    ]),
    ...recipe.fields.map((f) => `\n--set ${f.id}=VALUE: ${f.label}\n  ${f.help}`),
    `\nSteps:\n${[...new Set(recipe.steps)].map((s) => `  ${s}`).join("\n")}`,
    `\nPrepare: orbit bench prepare ${recipe.id}`,
    "Import an existing definition: --registration-file /absolute/benchmark.json",
    "Downloads run in the daemon's machine; credentials are passed by environment variable name only.",
  ].join("\n");
}

export function registerPreparation(
  bench: Command,
  client: () => Promise<OrbitClient>,
  print: Print,
): void {
  bench
    .command("resources [family]")
    .description("official resources and preparation instructions for every supported benchmark")
    .option("--json", "print JSON")
    .action(async (family: string | undefined, o: { json?: boolean }) => {
      const catalog = await (await client()).benchResources();
      const recipe = family ? catalog.recipes.find((r) => r.id === family) : undefined;
      if (family && !recipe) throw new Error(`Unknown benchmark: ${family}`);
      print(o.json, recipe ?? catalog, () =>
        recipe
          ? formatRecipe(recipe)
          : [
              `Download directory: ${catalog.directory}`,
              ...catalog.recipes.map((r) => `${r.id.padEnd(25)} ${r.name}`),
              "\nRun orbit bench resources <family> for sources, local reuse and authorization instructions.",
            ].join("\n"),
      );
    });
  bench
    .command("prepare <family>")
    .description("download or reuse official resources, prepare and validate registration")
    .option("--name <name>", "registration name (single-suite recipes)")
    .option("--directory <path>", "persistent resource directory on the daemon's machine")
    .option(
      "--reuse <RESOURCE=PATH>",
      "reuse existing resources without changing them",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option(
      "--set <KEY=VALUE>",
      "recipe input; see bench resources <family>",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option(
      "--authorized <resource>",
      "acknowledge that you have completed the official access requirements",
      (v, p: string[]) => [...p, v],
      [],
    )
    .option(
      "--registration-file <path>",
      "import an existing benchmark definition after validation",
    )
    .option(
      "--proxy <url>",
      "HTTP download proxy without credentials; applies only to this preparation",
    )
    .option(
      "--token-env <name>",
      "daemon environment variable holding the download token; never the token itself",
    )
    .option("--json", "print JSON")
    .action(
      async (
        family: string,
        o: {
          name?: string;
          directory?: string;
          reuse: string[];
          set: string[];
          authorized: string[];
          registrationFile?: string;
          proxy?: string;
          tokenEnv?: string;
          json?: boolean;
        },
      ) => {
        const run = await (await client()).benchPrepare(family, {
          name: o.name,
          directory: o.directory ? resolve(o.directory) : undefined,
          reuse: Object.fromEntries(
            Object.entries(kv(o.reuse, "--reuse")).map(([key, path]) => [key, resolve(path)]),
          ),
          values: kv(o.set, "--set"),
          authorized: o.authorized,
          registrationFile: o.registrationFile ? resolve(o.registrationFile) : undefined,
          proxy: o.proxy,
          tokenEnv: o.tokenEnv,
        });
        print(
          o.json,
          run,
          () =>
            `${run.id}: preparing ${family}\nFollow: orbit logs ${run.id} -f\nWait: orbit wait ${run.id}\nRegistration status: orbit bench preparation ${run.id}`,
        );
      },
    );
  bench
    .command("preparation <run>")
    .description("show resource preparation, required actions and registration results")
    .option("--json", "print JSON")
    .action(async (id: string, o: { json?: boolean }) => {
      const status = await (await client()).benchPreparation(id);
      print(o.json, status, () =>
        [
          status.state,
          ...status.registrations.map((n) => `Registered: ${n}`),
          ...status.pending.map((p) => `Action needed: ${p}`),
        ].join("\n"),
      );
    });
}
