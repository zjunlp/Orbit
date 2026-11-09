import { TAXONOMY_FIELDS, TAXONOMY_GROUPS, type TaxonomyField } from "@zjunlp/orbit/taxonomy";
import { useId } from "react";
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
import { setQuery, useLocation } from "../../lib/router.ts";
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
  const id = useId();
  const activeDimension = useLocation().query.get("dimension");
  const setActiveDimension = (dimension: string | null) => setQuery({ dimension });
  const dimension = TAXONOMY_GROUPS.find((g) => g.id === activeDimension);
  return (
    <>
      <section className="dimension-categories" aria-label="Six classification dimensions">
        <div className="dimension-heading">
          <h2>Browse by category</h2>
          <p>Explore six dimensions. Combine filters to find the right benchmark.</p>
        </div>
        <div className="dimension-bar">
          {TAXONOMY_GROUPS.map((group, i) => {
            const n = group.fields.reduce((sum, f) => sum + (filters[f]?.length ?? 0), 0);
            const Icon = DIMENSION_ICONS[i] ?? IconLayers;
            return (
              <button
                type="button"
                key={group.id}
                className={`dimension-button${activeDimension === group.id ? " expanded" : ""}${n ? " selected" : ""}`}
                aria-expanded={activeDimension === group.id}
                id={`${id}-${group.id}`}
                aria-labelledby={`${id}-${group.id}-name`}
                aria-describedby={`${id}-${group.id}-summary ${id}-${group.id}-status`}
                aria-controls={activeDimension === group.id ? `${id}-options` : undefined}
                onClick={() => setActiveDimension(activeDimension === group.id ? null : group.id)}
              >
                <span className="dimension-icon">
                  <Icon size={24} />
                </span>
                <span className="dimension-name" id={`${id}-${group.id}-name`}>
                  {group.label}
                </span>
                <span className="dimension-summary" id={`${id}-${group.id}-summary`}>
                  {group.question}
                </span>
                <span className="dimension-action">
                  <span className="dimension-status" id={`${id}-${group.id}-status`}>
                    {n ? `${n} selected` : "Choose filters"}
                  </span>
                  <IconChevronDown size={17} />
                </span>
              </button>
            );
          })}
        </div>
      </section>
      {dimension && (
        <section
          id={`${id}-options`}
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
              onClick={() => {
                document.getElementById(`${id}-${dimension.id}`)?.focus();
                setActiveDimension(null);
              }}
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
