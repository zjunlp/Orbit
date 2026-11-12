// The rubric of a trial: every criterion the scorer graded (`review.items`), what it earned and
// why. Counts only: the trial's score is the scorer's and is never recomputed here.
import { useState } from "react";
import { IconCheck, IconCircle, IconX } from "../../components/icons.tsx";
import type { ReviewItem } from "../../lib/api.ts";
import { fmtScore } from "../../lib/format.ts";
import { extraFields, type ItemState, itemState, showValue } from "../../lib/review.ts";
import { Reasoning } from "./parts.tsx";

const ITEM_FIELDS = ["criterion", "score", "maxScore", "weight", "type", "reasoning"] as const;

const STATE_LABEL: Record<ItemState, string> = {
  full: "full marks",
  partial: "partial",
  zero: "no marks",
  scored: "scored",
  none: "not scored",
};
const STATES: ItemState[] = ["full", "partial", "zero", "scored", "none"];

function StateIcon({ state }: { state: ItemState }) {
  if (state === "full") return <IconCheck size={14} strokeWidth={2.6} />;
  if (state === "zero") return <IconX size={14} strokeWidth={2.6} />;
  return <IconCircle size={13} strokeDasharray={state === "none" ? "3 3" : undefined} />;
}

export function RubricView({ items }: { items: ReviewItem[] }) {
  const [lost, setLost] = useState(false);
  const rows = items.map((it, i) => ({ it, i, state: itemState(it) }));
  const count = (s: ItemState) => rows.filter((r) => r.state === s).length;
  const losing = rows.filter((r) => r.state === "partial" || r.state === "zero");
  const weight = items.reduce((a, it) => a + (it.weight ?? 0), 0);
  const shown = lost ? losing : rows;
  return (
    <div className="page-pad">
      <section className="card rubric">
        <div className="card-h">
          Rubric
          <span className="sub">
            {items.length} {items.length === 1 ? "criterion" : "criteria"}
          </span>
          {STATES.filter((s) => count(s) > 0).map((s) => (
            <span key={s} className={`rubric-count st-${s}`}>
              {count(s)} {STATE_LABEL[s]}
            </span>
          ))}
          {weight > 0 && <span className="sub">total weight {fmtScore(weight)}</span>}
          <div className="spacer" />
          {losing.length > 0 && losing.length < rows.length && (
            <div className="seg">
              <button type="button" className={lost ? "" : "on"} onClick={() => setLost(false)}>
                All
              </button>
              <button type="button" className={lost ? "on" : ""} onClick={() => setLost(true)}>
                Lost points {losing.length}
              </button>
            </div>
          )}
        </div>
        <ol className="chk-list">
          {shown.map(({ it, i, state }) => {
            const extras = extraFields(it, ITEM_FIELDS);
            const ratio =
              it.score != null && it.maxScore !== undefined && it.maxScore > 0
                ? Math.min(1, Math.max(0, it.score / it.maxScore))
                : null;
            return (
              <li key={String(i)} className={`chk st-${state}`}>
                <span className="chk-icon" title={STATE_LABEL[state]}>
                  <StateIcon state={state} />
                </span>
                <div className="chk-main">
                  <div className="chk-head">
                    <span className="faint num">{i + 1}</span>
                    {it.type && <span className="chip mono">{it.type}</span>}
                    <span className="rubric-criterion">
                      <Reasoning text={it.criterion} limit={480} />
                    </span>
                  </div>
                  {it.reasoning && (
                    <p className="chk-text">
                      <Reasoning text={it.reasoning} />
                    </p>
                  )}
                  {extras.length > 0 && (
                    <div className="faint mono rubric-extras">
                      {extras.map(([k, v]) => `${k}: ${showValue(v)}`).join(" · ")}
                    </div>
                  )}
                </div>
                <div className="chk-side rubric-score">
                  <span className="num">
                    <b>{it.score == null ? "—" : fmtScore(it.score)}</b>
                    {it.maxScore !== undefined && (
                      <span className="faint"> / {fmtScore(it.maxScore)}</span>
                    )}
                  </span>
                  {ratio !== null && (
                    <span className="rubric-bar" aria-hidden="true">
                      <i style={{ width: `${ratio * 100}%` }} />
                    </span>
                  )}
                  {it.weight !== undefined && (
                    <span className="faint">weight {fmtScore(it.weight)}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
