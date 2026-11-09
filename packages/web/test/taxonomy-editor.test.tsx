import type { BenchLabels, CatalogEntry } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  TaxonomyEditor,
  taxonomyEditorDraft,
  taxonomyEditorLabels,
} from "../src/pages/bench/TaxonomyEditor.tsx";

vi.mock("../src/components/ui.tsx", () => ({ toast: vi.fn() }));

const identity = { id: "example", name: "Example", version: "1.0", variant: "executable" };

it("round trips inherited, unknown, empty and custom fields without losing legacy labels", () => {
  const own: BenchLabels = {
    identity,
    domains: ["legacy-domain"],
    taxonomy: { domains: ["software"], targets: null, participants: [] },
  };
  const draft = taxonomyEditorDraft(own.taxonomy);
  expect(draft.domains).toEqual({ source: "custom", values: ["software"] });
  expect(draft.targets.source).toBe("unknown");
  expect(draft.participants.source).toBe("none");
  expect(draft.interfaces.source).toBe("adapter");
  expect(taxonomyEditorLabels(own, own.identity, draft)).toEqual(own);
  expect(own.taxonomy).toEqual({ domains: ["software"], targets: null, participants: [] });
});

it("removes inherited overrides and preserves explicit unknown and empty values on the wire", () => {
  const own: BenchLabels = { identity, taxonomy: { domains: ["software"] } };
  const draft = taxonomyEditorDraft(own.taxonomy);
  draft.domains.source = "adapter";
  draft.targets.source = "unknown";
  draft.participants.source = "none";
  const labels = taxonomyEditorLabels(own, undefined, draft);
  expect(JSON.parse(JSON.stringify(labels))).toEqual({
    identity,
    taxonomy: { targets: null, participants: [] },
  });
  draft.targets.source = "adapter";
  draft.participants.source = "adapter";
  expect(taxonomyEditorLabels(own, undefined, draft)).toEqual({ identity });
  expect(taxonomyEditorLabels(undefined, undefined, draft)).toEqual({});
});

it("requires an explicit None choice instead of silently converting an empty Custom choice", () => {
  const draft = taxonomyEditorDraft();
  draft.participants.source = "custom";
  expect(() => taxonomyEditorLabels(undefined, undefined, draft)).toThrow("select None");
  draft.participants.values = ["human-user"];
  expect(taxonomyEditorLabels(undefined, undefined, draft)).toEqual({
    taxonomy: { participants: ["human-user"] },
  });
});

it("edits registration defaults without turning the catalog task union into selected defaults", () => {
  const entry = {
    benchmark: { name: "example-registration", labels: { domains: ["legacy-domain"] } },
    identity,
    taxonomy: { domains: ["software", "robotics"], participants: ["human-user"] },
  } as CatalogEntry;
  const html = renderToStaticMarkup(
    <TaxonomyEditor e={entry} onClose={() => {}} onSaved={() => {}} />,
  );
  expect(html).toContain("<dialog");
  expect(html).toContain("aria-labelledby=");
  expect(html.match(/<details/g)).toHaveLength(6);
  expect(html.match(/value="adapter" selected=""/g)).toHaveLength(11);
  expect(html.match(/value="adapter" selected="">Inherit defaults/g)).toHaveLength(11);
  expect(html).not.toContain("Use adapter");
  expect(html).not.toContain('type="checkbox"');
  expect(html).toContain('value="executable"');
  expect(html).toContain("Each task’s own declarations take priority");
  expect(html).toContain("Legacy domain labels are preserved: legacy-domain");
  expect(html).toContain("These labels also supply inherited domain defaults");
  const withoutLegacyLabels = renderToStaticMarkup(
    <TaxonomyEditor
      e={{ ...entry, benchmark: { ...entry.benchmark, labels: undefined } }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(withoutLegacyLabels).not.toContain("Legacy domain labels");
});
