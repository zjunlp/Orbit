import type { PreparationRecipe, PreparationStatus } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PreparationForm, PreparationResult } from "../src/pages/bench/Preparation.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));

it("explains gated access and existing-file reuse before starting a download", () => {
  const recipe: PreparationRecipe = {
    id: "fixture",
    name: "Fixture benchmark",
    description: "Explicit UI fixture",
    guide: "https://example.invalid/setup",
    resources: [
      {
        id: "data",
        label: "Original data",
        kind: "file",
        url: "https://example.invalid/data",
        access: "authorization",
        authorizationUrl: "https://example.invalid/access",
        instructions: "Accept the original terms before downloading.",
      },
    ],
    fields: [],
    steps: ["Validate task listing and register with Orbit"],
    registrationNames: [],
  };
  const html = renderToStaticMarkup(<PreparationForm recipe={recipe} directory="/tmp/resources" />);
  expect(html).toContain('href="https://example.invalid/access"');
  expect(html).toContain("I have completed the official access requirements");
  expect(html).toContain("Reuse an existing local path");
  expect(html).toContain("Token environment variable name");
  expect(html).toContain("never the token");
});

it("shows required actions and does not describe registration as calibration", () => {
  const fixture = {
    run: { id: "fixture-run" },
    family: "fixture",
    state: "needs_input",
    pending: ["Obtain official access"],
    registrations: [],
    resources: {},
  } as unknown as PreparationStatus;
  const pending = renderToStaticMarkup(<PreparationResult status={fixture} />);
  expect(pending).toContain("Obtain official access");
  expect(pending).toContain("Completed downloads are retained");
  expect(pending).toContain("/runs/fixture-run");
  const registered = renderToStaticMarkup(
    <PreparationResult
      status={{ ...fixture, state: "registered", pending: [], registrations: ["prepared-fixture"] }}
    />,
  );
  expect(registered).toContain("benchmark calibration");
  expect(registered).toContain("remain separate checks");
  expect(registered).toContain("setup=prepared-fixture");
});
