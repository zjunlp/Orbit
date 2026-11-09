import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/bin.ts",
    contracts: "src/contracts/index.ts",
    naming: "src/contracts/naming.ts",
    metrics: "src/contracts/metrics.ts",
    categories: "src/contracts/categories.ts",
    taxonomy: "src/contracts/taxonomy.ts",
    "plugin/dsh": "src/dsh.ts",
  },
  format: "esm",
  platform: "node",
  target: "node24",
  dts: true,
  clean: true,
});
