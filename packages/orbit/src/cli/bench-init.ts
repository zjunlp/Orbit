import { resolve } from "node:path";
import type { Command } from "commander";
import type { OrbitClient } from "../client/index.ts";
import { BenchInitRequest } from "../contracts/index.ts";
import type { Print } from "./auth.ts";

export function registerBenchInit(
  bench: Command,
  client: () => Promise<OrbitClient>,
  print: Print,
) {
  bench
    .command("init <name> <directory>")
    .description("Create a synthetic CPU tutorial benchmark (does not register or run it)")
    .option("--template <template>", "adapter or manifest", "adapter")
    .option("--json", "print JSON")
    .action(async (name, directory, opts) => {
      const result = await (await client()).benchInit(
        BenchInitRequest.parse({ name, directory: resolve(directory), template: opts.template }),
      );
      print(
        opts.json,
        result,
        () =>
          `Synthetic tutorial created: ${result.directory}\nThis is not real benchmark validation.\n${result.nextSteps.join("\n")}`,
      );
    });
}
