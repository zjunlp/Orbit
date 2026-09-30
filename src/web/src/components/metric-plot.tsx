import type { MetricSeries } from "../api/review.generated";

export function MetricPlot({
  series,
  baseline,
  label,
}: {
  series: MetricSeries;
  baseline?: MetricSeries;
  label: string;
}) {
  const points = [...series.points, ...(baseline?.points ?? [])];
  if (!points.length) return null;
  const xs = points.map((p) => p.step),
    ys = points.map((p) => p.value);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const x = (step: number) => 42 + ((step - minX) / (maxX - minX || 1)) * 506;
  const y = (value: number) =>
    144 - ((value - minY) / (maxY - minY || 1)) * 126;
  const path = (values: MetricSeries) =>
    values.points.map((p) => `${x(p.step)},${y(p.value)}`).join(" ");
  const latest = series.points.at(-1);
  return (
    <article className="metric-series">
      <div className="section-line">
        <strong>
          {series.name}
          {series.unit ? ` (${series.unit})` : ""}
        </strong>
        <span>
          {latest?.value.toPrecision(5)}{" "}
          <small className="muted">@ {latest?.step}</small>
        </span>
      </div>
      <svg
        viewBox="0 0 560 178"
        role="img"
        aria-label={`${series.name} 随 step 变化；实线为 ${label}，虚线为对照`}
      >
        <title>{series.name} 随 step 的变化</title>
        <line
          x1="42"
          x2="548"
          y1="144"
          y2="144"
          stroke="currentColor"
          opacity="0.15"
        />
        <text x="2" y="22">
          {maxY.toPrecision(3)}
        </text>
        <text x="2" y="144">
          {minY.toPrecision(3)}
        </text>
        <text x="42" y="168">
          {minX}
        </text>
        <text x="548" y="168" textAnchor="end">
          {maxX} step
        </text>
        {baseline && (
          <polyline
            points={path(baseline)}
            fill="none"
            stroke="currentColor"
            opacity="0.55"
            strokeDasharray="5 4"
            strokeWidth="2"
          />
        )}
        <polyline
          points={path(series)}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
        />
        {series.points.length === 1 && latest && (
          <circle
            cx={x(latest.step)}
            cy={y(latest.value)}
            r="3"
            fill="var(--accent)"
          />
        )}
      </svg>
      <small className="muted">
        {series.count} 个原始点
        {series.downsampled ? " · 图中已等距抽样，保留首尾" : ""}
        {baseline ? " · 虚线为对照" : ""}
      </small>
    </article>
  );
}
