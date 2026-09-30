import { useState } from "react";
import { request, useData } from "../api/console";
import type { ExperimentReview } from "../api/review.generated";
import type { ControlRun } from "../api/workflow";
import { Empty, Notice, Panel } from "../components/common";
import { MetricPlot } from "../components/metric-plot";

function Configuration({
  value,
  baseline,
}: {
  value: ExperimentReview;
  baseline?: ExperimentReview;
}) {
  const row = (label: string, current: string, before?: string) => (
    <tr key={label}>
      <th>{label}</th>
      <td className="break">{current}</td>
      {baseline && (
        <td className="break">
          {before ?? "未记录"}
          {before !== undefined && before !== current && (
            <small className="review-difference"> 有变化</small>
          )}
        </td>
      )}
    </tr>
  );
  const resources = (v: ExperimentReview) =>
    v.request
      ? `${v.request.cpu_cores} CPU / ${(v.request.memory_bytes / 1024 ** 3).toFixed(2)} GiB / GPU ${v.request.gpu_device_ids.join(", ") || "无"}`
      : "未记录";
  const mounts = (v: ExperimentReview) =>
    v.request?.mounts.map((m) => `${m.source} → ${m.target}`).join("; ") ||
    "无";
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>配置</th>
            <th>本次实验</th>
            {baseline && <th>对照实验</th>}
          </tr>
        </thead>
        <tbody>
          {row(
            "代码摘要",
            value.code.digest ?? "未记录",
            baseline?.code.digest ?? "未记录",
          )}
          {row(
            "Git 提交",
            value.code.commit?.slice(0, 12) ?? "非 Git 工作区",
            baseline?.code.commit?.slice(0, 12) ?? "非 Git 工作区",
          )}
          {row(
            "镜像",
            value.image_id ?? "未记录",
            baseline?.image_id ?? "未记录",
          )}
          {row(
            "命令",
            JSON.stringify(value.request?.argv ?? []),
            JSON.stringify(baseline?.request?.argv ?? []),
          )}
          {row("资源", resources(value), baseline && resources(baseline))}
          {row("只读数据", mounts(value), baseline && mounts(baseline))}
        </tbody>
      </table>
      <p className="muted">
        数据挂载记录路径，不把可变的外部数据集宣称为内容快照。代码差异相对于各自
        Git HEAD。
      </p>
    </div>
  );
}

export function ExperimentReviewPanel({
  token,
  runId,
  baselineId,
  canRun = false,
}: {
  token: string;
  runId: string;
  baselineId?: string;
  canRun?: boolean;
}) {
  const endpoint = `execution/runs/${encodeURIComponent(runId)}`;
  const review = useData<ExperimentReview>(
    token,
    `${endpoint}/review`,
    5000,
    (value) => value.state === "finished",
  );
  const baseline = useData<ExperimentReview>(
    token,
    baselineId
      ? `execution/runs/${encodeURIComponent(baselineId)}/review`
      : null,
    5000,
    (value) => value.state === "finished",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [operation, setOperation] = useState<string | null>(null);
  const value = review.data;
  return (
    <Panel title="实验复盘">
      <Notice
        error={review.error || baseline.error || error}
        loading={!value}
      />
      {value && (
        <>
          <div className="section-line">
            <div>
              <strong>{value.name}</strong>
              <p className="muted">
                {value.execution ?? value.state} · 归档{" "}
                {value.capture ?? "等待归档"} ·{" "}
                {new Date(value.created_at).toLocaleString()}
              </p>
            </div>
            <a href={`#execution/${runId}`}>日志与产物 ↗</a>
          </div>
          {value.parent_run_id && (
            <p>
              重跑来源：
              <a href={`#execution/${value.parent_run_id}`}>
                {value.parent_run_id.slice(0, 12)}
              </a>
            </p>
          )}
          <Configuration value={value} baseline={baseline.data ?? undefined} />
          <div className="review-metrics">
            {value.metrics.series.map((series) => (
              <MetricPlot
                key={`${series.name}:${series.unit}`}
                series={series}
                baseline={baseline.data?.metrics.series.find(
                  (item) =>
                    item.name === series.name && item.unit === series.unit,
                )}
                label={value.name}
              />
            ))}
          </div>
          {!value.metrics.series.length && (
            <Empty>
              尚无指标曲线。在容器的 outputs/metrics.jsonl 中逐行写入{" "}
              {`{"step": 1, "loss": 0.25}`}，归档后即可查看。
            </Empty>
          )}
          {[...value.issues, ...value.metrics.issues].map((issue) => (
            <p className="error" key={issue}>
              {issue}
            </p>
          ))}
          <details>
            <summary>代码差异与快照 · {value.code.files.length} 个文件</summary>
            <p className="muted">
              排除数据、权重、认证目录和生成结果；完整清单与差异保存在
              .infra-evidence 产物中。
            </p>
            <pre>
              {value.code.patch ||
                (value.code.commit
                  ? "无已跟踪代码差异；未跟踪文件以快照为准。"
                  : "非 Git 工作区，使用内容摘要和受控代码快照。")}
            </pre>
            {value.code.patch_truncated && (
              <p>预览已截断，请从产物下载完整 code.patch。</p>
            )}
            <details>
              <summary>纳入快照的文件</summary>
              <pre>{value.code.files.join("\n") || "等待归档"}</pre>
            </details>
          </details>
          {value.request?.session_id && (
            <p>
              关联宿主机会话：{value.request.provider ?? "未指定 provider"} ·{" "}
              {value.request.session_id}（已绑定的会话可在项目页查看）
            </p>
          )}
          {value.request && value.state === "finished" && (
            <div className="actions">
              <button
                type="button"
                disabled={busy || !canRun}
                onClick={async () => {
                  if (
                    !operation &&
                    !window.confirm(
                      "使用当前工作区代码，沿用本次命令、镜像名和资源上限创建新实验？旧结果会保留。",
                    )
                  )
                    return;
                  const key = operation ?? crypto.randomUUID();
                  setOperation(key);
                  setBusy(true);
                  setError("");
                  try {
                    const next = await request<ControlRun>(
                      token,
                      `${endpoint}/rerun`,
                      { operation_id: key },
                    );
                    window.location.hash = `execution/${next.run_id}`;
                  } catch (reason) {
                    setError(String(reason));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "正在提交…"
                  : operation
                    ? "重试同一提交"
                    : "用当前代码重跑"}
              </button>
              {!canRun && (
                <small className="muted">
                  连接同一状态目录的 Controller 后可重跑
                </small>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export function ProjectExperiments({
  token,
  runs,
  canRun,
}: {
  token: string;
  runs: ControlRun[];
  canRun: boolean;
}) {
  const commands = runs.filter((run) => run.kind === "command");
  const [selected, setSelected] = useState(""),
    [baseline, setBaseline] = useState("");
  const active = commands.some((run) => run.run_id === selected)
    ? selected
    : commands[0]?.run_id;
  if (!active) return null;
  const options = commands.map((run) => (
    <option key={run.run_id} value={run.run_id}>
      {run.lineage.name ?? run.run_id.slice(0, 12)} ·{" "}
      {new Date(run.created_at).toLocaleString()}
    </option>
  ));
  return (
    <>
      <div className="review-selectors">
        <label>
          查看实验
          <select
            aria-label="查看实验"
            value={active}
            onChange={(e) => setSelected(e.target.value)}
          >
            {options}
          </select>
        </label>
        <label>
          对照实验
          <select
            aria-label="对照实验"
            value={baseline}
            onChange={(e) => setBaseline(e.target.value)}
          >
            <option value="">不对照</option>
            {options}
          </select>
        </label>
      </div>
      <ExperimentReviewPanel
        key={active}
        token={token}
        runId={active}
        baselineId={baseline && baseline !== active ? baseline : undefined}
        canRun={canRun}
      />
    </>
  );
}
