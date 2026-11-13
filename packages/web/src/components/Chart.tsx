// uPlot wrapper: one chart = one metric key, one or more series (runs). Handles resize, theme
// colors, EMA smoothing (raw series drawn faint behind), log scale and cursor sync across charts.
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { ema } from "../lib/ema.ts";
import { num } from "../lib/format.ts";

export const PALETTE = [
  "#58a6ff",
  "#f778ba",
  "#3fb950",
  "#d29922",
  "#a371f7",
  "#39c5cf",
  "#ff7b72",
  "#7ee787",
  "#ffa657",
  "#79c0ff",
  "#d2a8ff",
  "#56d364",
];

export interface ChartSeries {
  label: string;
  color: string;
  points: [number, number][];
  /** Draw thicker (e.g. baseline or aggregated mean). */
  emphasis?: boolean;
  faint?: boolean;
}

export interface ChartProps {
  series: ChartSeries[];
  smoothing: number;
  logY?: boolean;
  syncKey?: string;
  height?: number;
  onHover?: (
    vals: { label: string; color: string; value: number | null }[],
    step: number | null,
  ) => void;
}

const ids = new WeakMap<object, number>();
let nextId = 0;
function pointsId(p: object): number {
  let id = ids.get(p);
  if (id === undefined) {
    id = nextId++;
    ids.set(p, id);
  }
  return id;
}

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Merge series with different x values into uPlot's aligned table (null where missing). */
function align(series: ChartSeries[]): { xs: number[]; ys: (number | null)[][] } {
  const xsSet = new Set<number>();
  for (const s of series) for (const [x] of s.points) xsSet.add(x);
  const xs = [...xsSet].sort((a, b) => a - b);
  const index = new Map(xs.map((x, i) => [x, i]));
  const ys = series.map((s) => {
    const col: (number | null)[] = new Array(xs.length).fill(null);
    for (const [x, y] of s.points) col[index.get(x) as number] = Number.isFinite(y) ? y : null;
    return col;
  });
  return { xs, ys };
}

export function Chart({ series, smoothing, logY, syncKey, height = 220, onHover }: ChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const zoomed = useRef(false);
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);

  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // Callers may pass fresh arrays every render; key the memo on content identity instead so hover
  // re-renders don't rebuild the plot. Styles and data are keyed separately so polling only
  // swaps data (keeping zoom) instead of recreating the chart.
  const styleSig = series
    .map((s) => `${s.label}|${s.color}|${s.emphasis}|${s.faint}|${s.points.length < 40}`)
    .join(";");
  const dataSig = `${series.map((s) => pointsId(s.points)).join(",")}|${smoothing}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by styleSig
  const sdefs = useMemo(() => {
    const smooth = smoothing > 0;
    const defs: uPlot.Series[] = [{}];
    for (const s of series) {
      if (smooth && !s.faint)
        defs.push({
          label: `${s.label} (raw)`,
          stroke: `${s.color}40`,
          width: 1,
          points: { show: false },
          spanGaps: true,
        });
      defs.push({
        label: s.label,
        stroke: s.faint ? `${s.color}55` : s.color,
        width: s.emphasis ? 2.25 : s.faint ? 1 : 1.5,
        points: { show: s.points.length < 40, size: 4, fill: s.color },
        spanGaps: true,
      });
    }
    return defs;
  }, [styleSig, smoothing > 0]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by dataSig
  const data = useMemo(() => {
    const smooth = smoothing > 0;
    const expanded: ChartSeries[] = [];
    for (const s of series) {
      if (smooth && !s.faint) {
        expanded.push(s);
        const ys = ema(
          s.points.map((p) => p[1]),
          smoothing,
        );
        expanded.push({ ...s, points: s.points.map(([x], i) => [x, ys[i] as number]) });
      } else expanded.push(s);
    }
    const { xs, ys } = align(expanded);
    return [xs, ...ys] as uPlot.AlignedData;
  }, [dataSig]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme changes rebuild axes colors
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const grid = css("--border");
    const text = css("--text-3");
    const axis: uPlot.Axis = {
      stroke: text,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1, size: 4 },
      font: "11px Inter Variable, system-ui, sans-serif",
      values: (_u, vals) => vals.map((v) => num(v)),
    };
    const opts: uPlot.Options = {
      width: node.clientWidth,
      height,
      series: sdefs,
      scales: { x: { time: false }, y: logY ? { distr: 3 } : {} },
      axes: [
        { ...axis },
        {
          ...axis,
          // Wide enough for the longest tick label: an exponent such as 8.00e-10 needs more than 56.
          size: (_u, values) =>
            Math.max(56, 14 + 6.5 * Math.max(0, ...(values ?? []).map((value) => value.length))),
        },
      ],
      legend: { show: false },
      cursor: {
        sync: syncKey ? { key: syncKey } : undefined,
        points: { size: 6 },
        drag: { x: true, y: false },
      },
      padding: [8, 12, 0, 0],
      hooks: {
        // A drag selection zooms x; remember it so polled data doesn't reset the view.
        setSelect: [
          (u) => {
            if (u.select.width > 0) zoomed.current = true;
          },
        ],
        setCursor: [
          (u) => {
            const h = hoverRef.current;
            if (!h) return;
            const i = u.cursor.idx;
            if (i === null || i === undefined) return h([], null);
            const vals = u.series.slice(1).flatMap((s, k) =>
              (sdefs[k + 1]?.label as string | undefined)?.endsWith("(raw)")
                ? []
                : [
                    {
                      label: String(s.label),
                      color: String(sdefs[k + 1]?.stroke),
                      value: (u.data[k + 1]?.[i] as number | null | undefined) ?? null,
                    },
                  ],
            );
            h(vals, (u.data[0][i] as number | undefined) ?? null);
          },
        ],
      },
    };
    zoomed.current = false;
    const p = new uPlot(opts, dataRef.current, node);
    plot.current = p;
    const ro = new ResizeObserver(() => p.setSize({ width: node.clientWidth, height }));
    ro.observe(node);
    return () => {
      ro.disconnect();
      p.destroy();
      plot.current = null;
    };
  }, [sdefs, logY, syncKey, height, theme]);

  dataRef.current = data;
  useEffect(() => {
    plot.current?.setData(data, !zoomed.current);
  }, [data]);

  return (
    <div
      ref={el}
      style={{ width: "100%", height }}
      onDoubleClick={() => {
        zoomed.current = false;
        plot.current?.setData(data);
      }}
    />
  );
}

/** A tiny inline sparkline (no axes) for tables and summaries. */
export function Sparkline({
  points,
  color = "var(--accent)",
  width = 120,
  height = 28,
}: {
  points: [number, number][];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <span className="faint">—</span>;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]).filter(Number.isFinite);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => ((x - x0) / (x1 - x0 || 1)) * (width - 2) + 1;
  const sy = (y: number) => height - 2 - ((y - y0) / (y1 - y0 || 1)) * (height - 4);
  const d = points
    .filter((p) => Number.isFinite(p[1]))
    .map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`)
    .join("");
  return (
    <svg width={width} height={height} style={{ display: "block" }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
