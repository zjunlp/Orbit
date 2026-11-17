#!/usr/bin/env node
// Composition root for the `orbit` executable: the CLI talks to the daemon over HTTP,
// `orbit daemon` runs the daemon in this same binary, `__docker-shim` is the `docker` that process
// runs see and `__adapter` runs a built-in bench adapter (both kept light: they load nothing else).
const [, , first, ...rest] = process.argv;

if (first === "__docker-shim") {
  const { shimMain } = await import("./runs/shim.ts");
  shimMain(rest[0] ?? "", rest.slice(1));
} else if (first === "__prepare") {
  const { preparationMain } = await import("./bench/preparation-worker.ts");
  await preparationMain(rest[0] ?? "");
} else if (first === "__adapter") {
  const { adapterMain } = await import("./bench/adapter.ts");
  await adapterMain(rest[0] ?? "", rest[1] ?? "");
} else {
  const { createProgram } = await import("./cli/program.ts");
  // The daemon is loaded only by `orbit daemon` (and the CLI auto-starting one), not every command.
  const runDaemon: import("./cli/program.ts").ProgramDeps["runDaemon"] = async (paths, port) =>
    (await import("./daemon/main.ts")).runDaemon(paths, port);
  createProgram({ runDaemon })
    .parseAsync()
    .catch((e: unknown) => {
      console.error(`orbit: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
