// Small pieces shared by the trial views.
import { Fragment, useState } from "react";
import { fileUrl } from "../../lib/api.ts";
import { isBlank, showValue } from "../../lib/review.ts";
import "./review.css";

/** The bar above a saved file: where it is, what to know about it, and the original to download. */
export function FileBar(props: { runId: string; path: string; children?: React.ReactNode }) {
  return (
    <div className="toolbar file-bar">
      <span className="mono faint ellipsis" title={props.path}>
        {props.path}
      </span>
      {props.children}
      <div className="spacer" />
      <a className="btn sm" href={fileUrl(props.runId, props.path, true)}>
        Download
      </a>
    </div>
  );
}

/** Long text folded to its beginning. */
export function Reasoning({ text, limit = 320 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= limit) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, limit)}… `}
      <button type="button" className="btn ghost sm" onClick={() => setOpen(!open)}>
        {open ? "less" : "more"}
      </button>
    </>
  );
}

const plain = (v: unknown) => v === null || typeof v !== "object";

/**
 * A saved value as text: scalars and short lists inline, an object as nested key / value rows
 * (blank fields left out), anything deeper as JSON.
 */
export function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (isBlank(value)) return <span className="faint">—</span>;
  if (plain(value)) return <>{showValue(value)}</>;
  if (Array.isArray(value) && value.every(plain)) return <>{value.map(showValue).join(", ")}</>;
  if (Array.isArray(value) || depth >= 2)
    return <pre className="value-json">{JSON.stringify(value, null, 2)}</pre>;
  return (
    <dl className="kv nested">
      {Object.entries(value as object)
        .filter(([, v]) => !isBlank(v))
        .map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>
              <Value value={v} depth={depth + 1} />
            </dd>
          </Fragment>
        ))}
    </dl>
  );
}
