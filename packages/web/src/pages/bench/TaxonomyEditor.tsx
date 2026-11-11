import type { BenchLabels, BenchTaxonomy, CatalogEntry } from "@zjunlp/orbit/contracts";
import { TAXONOMY_FIELDS, TAXONOMY_GROUPS } from "@zjunlp/orbit/taxonomy";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";

type TaxonomyField = keyof BenchTaxonomy;
type Source = "adapter" | "custom" | "unknown" | "none";
type TaxonomyDraft = Record<TaxonomyField, { source: Source; values: string[] }>;

const FIELD_KEYS = Object.keys(TAXONOMY_FIELDS) as TaxonomyField[];
const SOURCES: { value: Source; label: string }[] = [
  { value: "adapter", label: "Inherit defaults" },
  { value: "custom", label: "Custom" },
  { value: "unknown", label: "Unknown" },
  { value: "none", label: "None" },
];

export function taxonomyEditorDraft(taxonomy?: BenchTaxonomy): TaxonomyDraft {
  return Object.fromEntries(
    FIELD_KEYS.map((key) => {
      const value = taxonomy?.[key];
      const source: Source =
        value === undefined
          ? "adapter"
          : value === null
            ? "unknown"
            : value.length === 0
              ? "none"
              : "custom";
      return [key, { source, values: value ? [...value] : [] }];
    }),
  ) as TaxonomyDraft;
}

export function taxonomyEditorLabels(
  own: BenchLabels | undefined,
  identity: BenchLabels["identity"],
  draft: TaxonomyDraft,
): BenchLabels {
  const taxonomy = Object.fromEntries(
    FIELD_KEYS.filter((key) => draft[key].source !== "adapter").map((key) => {
      const field = draft[key];
      if (field.source === "custom" && !field.values.length) {
        throw new Error(`Choose a value for ${TAXONOMY_FIELDS[key].label}, or select None.`);
      }
      return [
        key,
        field.source === "unknown" ? null : field.source === "none" ? [] : [...field.values],
      ];
    }),
  ) as BenchTaxonomy;
  const labels: BenchLabels = { ...own, ...(identity ? { identity } : {}) };
  if (Object.keys(taxonomy).length) labels.taxonomy = taxonomy;
  else delete labels.taxonomy;
  return labels;
}

export function TaxonomyEditor({
  e,
  onClose,
  onSaved,
}: {
  e: CatalogEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const own = e.benchmark.labels;
  const initialIdentity = own?.identity ?? e.identity;
  const [identity, setIdentity] = useState({
    id: initialIdentity.id,
    name: initialIdentity.name,
    version: initialIdentity.version ?? "",
    variant: initialIdentity.variant ?? "",
  });
  const [draft, setDraft] = useState(() => taxonomyEditorDraft(own?.taxonomy));
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  const incomplete = FIELD_KEYS.some(
    (key) => draft[key].source === "custom" && !draft[key].values.length,
  );

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const close = () => {
    if (!busyRef.current) onClose();
  };
  const change = (key: TaxonomyField, update: Partial<TaxonomyDraft[TaxonomyField]>) => {
    setDraft((current) => ({ ...current, [key]: { ...current[key], ...update } }));
    setError(null);
  };
  const save = async (remove = false) => {
    if (busyRef.current || (!remove && incomplete)) return;
    busyRef.current = true;
    setBusy(remove ? "remove" : "save");
    setError(null);
    try {
      const identityChanged =
        identity.id !== initialIdentity.id ||
        identity.name !== initialIdentity.name ||
        identity.version !== (initialIdentity.version ?? "") ||
        identity.variant !== (initialIdentity.variant ?? "");
      const editedIdentity = identityChanged
        ? {
            id: identity.id.trim(),
            name: identity.name.trim() || identity.id.trim(),
            ...(identity.version.trim() ? { version: identity.version.trim() } : {}),
            ...(identity.variant.trim() ? { variant: identity.variant.trim() } : {}),
          }
        : own?.identity;
      await api.benchLabel(
        e.benchmark.name,
        remove ? {} : taxonomyEditorLabels(own, editedIdentity, draft),
      );
      toast(remove ? "Registration labels removed" : "Registration labels saved");
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="dialog taxonomy-editor"
      aria-labelledby={`${label}-title`}
      aria-describedby={`${label}-help`}
      aria-busy={Boolean(busy)}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmRemove) void save();
        }}
      >
        <div className="dialog-h taxonomy-editor-head">
          <div>
            <span className="taxonomy-editor-eyebrow">Registration labels</span>
            <h2 id={`${label}-title`}>{e.benchmark.name}</h2>
          </div>
          <button
            type="button"
            className="btn ghost"
            aria-label="Close label editor"
            disabled={Boolean(busy)}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div className="dialog-b taxonomy-editor-body">
          <p className="muted taxonomy-editor-help" id={`${label}-help`}>
            Set defaults for this registration. Each task’s own declarations take priority. Inherit
            defaults uses existing metadata; Unknown marks missing knowledge; None means no values
            apply.
          </p>
          <fieldset className="taxonomy-editor-identity" disabled={Boolean(busy)}>
            <legend>Benchmark identity</legend>
            <p className="faint">
              Registrations with the same ID count as one benchmark. Version and variant identify
              its release and protocol.
            </p>
            <div className="form-grid">
              {(["id", "name", "version", "variant"] as const).map((key) => (
                <div key={key} className="taxonomy-editor-identity-field">
                  <label htmlFor={`${label}-${key}`}>
                    {key === "id" ? "ID" : key.charAt(0).toUpperCase() + key.slice(1)}
                  </label>
                  <input
                    id={`${label}-${key}`}
                    className={`input${key === "id" ? " mono" : ""}`}
                    value={identity[key]}
                    required={key === "id"}
                    maxLength={key === "id" ? 64 : key === "name" ? 120 : 80}
                    pattern={key === "id" ? "[a-z0-9][a-z0-9._\\-]{0,63}" : undefined}
                    title={
                      key === "id"
                        ? "Lowercase letters, digits, dots, underscores and hyphens"
                        : undefined
                    }
                    placeholder={key === "version" || key === "variant" ? "Optional" : undefined}
                    onChange={(event) =>
                      setIdentity((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          </fieldset>
          <div className="taxonomy-editor-groups">
            {TAXONOMY_GROUPS.map((group, index) => {
              const overrides = group.fields.filter(
                (key) => draft[key].source !== "adapter",
              ).length;
              return (
                <details className="taxonomy-editor-group" key={group.id} open={index === 0}>
                  <summary className="taxonomy-editor-summary">
                    <span className="taxonomy-editor-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>
                      <strong>{group.label}</strong>
                      <span className="taxonomy-editor-question">{group.question}</span>
                    </span>
                    <span className="taxonomy-editor-status">
                      {overrides
                        ? `${overrides} ${overrides === 1 ? "override" : "overrides"}`
                        : "Inherit defaults"}
                    </span>
                  </summary>
                  {group.fields.map((key) => {
                    const field = TAXONOMY_FIELDS[key];
                    const state = draft[key];
                    return (
                      <fieldset
                        className="taxonomy-editor-field"
                        disabled={Boolean(busy)}
                        key={key}
                      >
                        <legend>{field.label}</legend>
                        <div className="taxonomy-editor-field-head">
                          <label
                            className="taxonomy-editor-source"
                            htmlFor={`${label}-${key}-source`}
                          >
                            Source
                            <select
                              id={`${label}-${key}-source`}
                              className="input"
                              aria-label={`${field.label} source`}
                              aria-describedby={`${label}-${key}-help`}
                              value={state.source}
                              onChange={(event) =>
                                change(key, { source: event.target.value as Source })
                              }
                            >
                              {SOURCES.map((source) => (
                                <option key={source.value} value={source.value}>
                                  {source.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p className="faint taxonomy-editor-help" id={`${label}-${key}-help`}>
                            {state.source === "adapter"
                              ? "Keep existing defaults when the task has no declaration."
                              : state.source === "unknown"
                                ? "Mark as unknown, even if an inherited default is available."
                                : state.source === "none"
                                  ? key === "participants"
                                    ? "Declare that there are no other participants."
                                    : "Declare that no values apply."
                                  : "Choose one or more values, or select None for an empty set."}
                          </p>
                        </div>
                        {state.source === "custom" && (
                          <div className="taxonomy-editor-options">
                            {field.values.map((option) => (
                              <label className="taxonomy-editor-option" key={option.value}>
                                <input
                                  type="checkbox"
                                  checked={state.values.includes(option.value)}
                                  onChange={(event) =>
                                    change(key, {
                                      values: event.target.checked
                                        ? [...state.values, option.value]
                                        : state.values.filter((value) => value !== option.value),
                                    })
                                  }
                                />
                                <span>{option.label}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </fieldset>
                    );
                  })}
                </details>
              );
            })}
          </div>
          {confirmRemove && (
            <div className="warnbox taxonomy-editor-remove">
              <p>
                Remove all registration labels, including identity and taxonomy defaults? Adapter
                metadata and task declarations will remain.
              </p>
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  disabled={Boolean(busy)}
                  onClick={() => setConfirmRemove(false)}
                >
                  Keep labels
                </button>
                <button
                  type="button"
                  className="btn danger"
                  disabled={Boolean(busy)}
                  onClick={() => void save(true)}
                >
                  {busy === "remove" ? "Removing…" : "Remove all labels"}
                </button>
              </div>
            </div>
          )}
          {error && (
            <div className="errbox taxonomy-editor-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-f taxonomy-editor-footer">
          {own && !confirmRemove && (
            <button
              type="button"
              className="btn ghost"
              disabled={Boolean(busy)}
              onClick={() => setConfirmRemove(true)}
            >
              Remove labels…
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={Boolean(busy) || incomplete || confirmRemove || !identity.id.trim()}
          >
            {busy === "save" ? "Saving…" : "Save labels"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
