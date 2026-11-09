import { TAXONOMY_FIELDS, TAXONOMY_GROUPS, type TaxonomyField } from "@zjunlp/orbit/taxonomy";
import { useState } from "react";
import {
  IconBox,
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconDashboard,
  IconLayers,
  IconTerminal,
  IconX,
} from "../../components/icons.tsx";
import {
  matchesTaxonomy,
  type TaxonomyFilters,
  type TaxonomySource,
  taxonomyLabel,
} from "../../lib/taxonomy.ts";

const DIMENSION_ICONS = [IconLayers, IconTerminal, IconBrain, IconDashboard, IconBox, IconCheck];
const countBenchmarks = (entries: { identity: { id: string } }[]) =>
  new Set(entries.map((e) => e.identity.id)).size;
export function TaxonomyFacets({
  entries,
  filters,
  toggle,
}: {
  entries: (TaxonomySource & { identity: { id: string } })[];
  filters: TaxonomyFilters;
  toggle: (field: TaxonomyField, value: string) => void;
}) {
  const [activeDimension, setActiveDimension] = useState<string | null>(null);
  const dimension = TAXONOMY_GROUPS.find((g) => g.id === activeDimension);
  return (
    <>
      <section className="dimension-bar" aria-label="Six classification dimensions">
        {TAXONOMY_GROUPS.map((group, i) => {
          const n = group.fields.reduce((sum, f) => sum + (filters[f]?.length ?? 0), 0);
          const Icon = DIMENSION_ICONS[i] ?? IconLayers;
          return (
            <button
              type="button"
              key={group.id}
              className={`dimension-button${activeDimension === group.id ? " expanded" : ""}${n ? " selected" : ""}`}
              aria-expanded={activeDimension === group.id}
              aria-controls="dimension-options"
              onClick={() => setActiveDimension(activeDimension === group.id ? null : group.id)}
            >
              <span className="dimension-number">
                0{i + 1}
                <Icon size={15} />
              </span>
              <span className="dimension-name">
                {group.label}
                <IconChevronDown size={13} />
              </span>
              <span className="dimension-summary">{n ? `${n} selected` : group.question}</span>
            </button>
          );
        })}
      </section>
      {dimension && (
        <section
          id="dimension-options"
          className="dimension-panel"
          aria-label={`${dimension.label} filters`}
        >
          <div className="dimension-panel-head">
            <div>
              <b>{dimension.label}</b>
              <p>Choose any values within a field. Different fields must match the same tasks.</p>
            </div>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Close filters"
              onClick={() => setActiveDimension(null)}
            >
              <IconX size={16} />
            </button>
          </div>
          <div className={`dimension-fields fields-${dimension.fields.length}`}>
            {dimension.fields.map((field) => (
              <fieldset key={field}>
                <legend>{TAXONOMY_FIELDS[field].label}</legend>
                <div className="dimension-options">
                  {[
                    ...TAXONOMY_FIELDS[field].values.map((v) => v.value),
                    "unlabeled",
                    "__none__",
                  ].map((value) => {
                    const count = countBenchmarks(
                      entries.filter((e) => matchesTaxonomy(e, { ...filters, [field]: [value] })),
                    );
                    const selected = filters[field]?.includes(value) ?? false;
                    if (!count && !selected) return null;
                    return (
                      <button
                        type="button"
                        key={value}
                        className={`dimension-option${selected ? " on" : ""}`}
                        aria-pressed={selected}
                        onClick={() => toggle(field, value)}
                      >
                        <span className="filter-check">{selected && <IconCheck size={11} />}</span>
                        <span>{taxonomyLabel(field, value)}</span>
                        <small>{count}</small>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
