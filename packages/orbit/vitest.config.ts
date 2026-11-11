import { defineConfig } from "vitest/config";

// The defaults are kept and the adapter directories are added: an adapter's own tests run here
// too, so a new adapter is covered without editing a list.
export default defineConfig({
  test: {
    include: [
      "**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "../../examples/bench-adapters/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
