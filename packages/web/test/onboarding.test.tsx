import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../src/lib/router.ts", () => ({ onLinkClick: vi.fn() }));

import { OnboardingView, onboardingError, tutorialFiles } from "../src/pages/bench/Onboarding.tsx";

it("validates name and daemon-host absolute paths without filesystem claims", () => {
  expect(onboardingError("tutorial", "/tmp/new dir")).toBeNull();
  expect(onboardingError("bad/name", "/tmp/new")).toContain("name");
  expect(onboardingError("tutorial", "relative")).toContain("absolute");
  expect(onboardingError("tutorial", "/")).toContain("absolute");
  expect(onboardingError("tutorial", "/tmp/\0bad")).toContain("absolute");
});
it("previews each existing template and makes creation scope explicit", () => {
  expect(tutorialFiles("adapter")).toContain("adapter.py");
  expect(tutorialFiles("manifest")).toContain("orbit-bench.yaml");
  expect(tutorialFiles("manifest")).not.toContain("adapter.py");
  const html = renderToStaticMarkup(<OnboardingView />);
  expect(html).toContain("Create tutorial");
  expect(html).toContain("parent directory must exist");
  expect(html).toContain("not real benchmark validation");
  expect(html).toContain("does not register, download, start runs or calibrate");
  expect(html).toContain("/benchmarks?mode=resources");
});
