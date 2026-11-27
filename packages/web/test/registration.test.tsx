import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { RegistrationForm } from "../src/pages/bench/Registration.tsx";
import { DEFINITION_LIMIT, parseDefinition } from "../src/pages/bench/registration-input.ts";

vi.mock("../src/lib/router.ts", () => ({ onLinkClick: vi.fn() }));
const definition = { name: "mine", adapter: "/tmp/adapter.py", path: "/tmp/tasks" };
it("parses object definitions and rejects malformed input before a daemon request", () => {
  expect(parseDefinition(JSON.stringify(definition))).toEqual(definition);
  for (const text of ["{", "null", "[]", "1"]) expect(() => parseDefinition(text)).toThrow();
  expect(() => parseDefinition('{"name":"mine"}')).toThrow("path string");
});
it("enforces a UTF-8 byte limit including multibyte text", () => {
  expect(() =>
    parseDefinition(JSON.stringify({ ...definition, extra: "é".repeat(DEFINITION_LIMIT / 2) })),
  ).toThrow("1 MiB");
  expect(() => parseDefinition(" ".repeat(DEFINITION_LIMIT + 1))).toThrow("1 MiB");
});
it("requires explicit check and registration, including tutorial-prefilled definitions", () => {
  const html = renderToStaticMarkup(<RegistrationForm definition={definition} />);
  expect(html).toContain("Checking invokes the adapter");
  expect(html).toContain("Paths refer to the daemon machine");
  expect(html).toContain("Check definition");
  expect(html).toMatch(/disabled="">Register local setup/);
  expect(html).not.toContain("Checked definition");
});
