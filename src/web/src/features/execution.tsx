import { useState } from "react";
import { known, request, useData } from "../api/console";
import type { Capabilities, ControlRun } from "../api/workflow";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  statusVariant,
} from "../components/common";
import { ArtifactFiles } from "./execution-artifacts";
import { ExecutionEvents } from "./execution-events";

function statusLabel(value: string | null | undefined): string {
  if (!value) return "未记录";
  const labels: Record<string, string> = {
    accepted: "已接收",
    running: "运行中",
    finished: "已结束",
    quarantined: "隔离待处理",
    completed: "已完成",
    complete: "完整",
    rejected: "被拒绝",
    failed: "失败",
    cleanup_failed: "清理失败",
    cancelled: "已取消",
    timed_out: "超时",
    pending: "待执行",
    not_requested: "未请求",
    not_run: "未执行",
  };
  return labels[value] ?? value;
}

export function ExecutionList({ runs }: { runs: ControlRun[] }) {
  return runs.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>状态</th>
            <th>执行结果</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.run_id}>
              <td>
                <a href={`#execution/${encodeURIComponent(run.run_id)}`}>
                  {run.run_id} ↗
                </a>
              </td>
              <td>
                {statusLabel(run.state)}
                {run.cancel_requested
                  ? run.state === "finished"
                    ? " · 已处理取消请求"
                    : " · 已请求取消"
                  : ""}
              </td>
              <td>
                {statusLabel(
                  run.result?.execution_status ?? run.result?.status,
                )}
              </td>
              <td>{new Date(run.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>
      还没有科研运行。从已采用的实验提交，或通过宿主机 Agent 开始科研。
    </Empty>
  );
}
export function ExecutionRecent({ token }: { token: string }) {
  const capabilities = useData<Capabilities>(token, "capabilities");
  const [offset, setOffset] = useState(0);
  const runs = useData<{ items: ControlRun[]; next_offset: number | null }>(
    token,
    capabilities.data?.project_workspaces
      ? `execution/runs?offset=${offset}`
      : null,
    5000,
  );
  if (!capabilities.data?.project_workspaces) return null;
  return (
    <Panel title="科研工作流运行">
      <Notice error={runs.error} />
      <ExecutionList runs={runs.data?.items ?? []} />
      <div className="actions">
        <button
          type="button"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          前 100 次
        </button>
        <button
          type="button"
          disabled={runs.data?.next_offset == null}
          onClick={() => setOffset(runs.data?.next_offset ?? 0)}
        >
          后 100 次
        </button>
      </div>
    </Panel>
  );
}
export function ExecutionDetail({ token, id }: { token: string; id: string }) {
  const path = `execution/runs/${encodeURIComponent(id)}`;
  const run = useData<ControlRun>(token, path, 5000, finished);
  const capabilities = useData<Capabilities>(token, "capabilities", 10000);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const value = run.data;
  return (
    <>
      <div className="section-line">
        <h2 className="break">{id}</h2>
        <a href="#runs">← 全部运行</a>
      </div>
      <Notice error={run.error || error} loading={!value} />
      {value && (
        <>
          <Panel title="运行状态">
            <Badge variant={statusVariant(value.state)}>
              运行阶段：{statusLabel(value.state)}
            </Badge>
            <p>
              执行结果：
              {value.result
                ? statusLabel(
                    value.result.execution_status ?? value.result.status,
                  )
                : "进行中 / 待执行"}
            </p>
            <p>
              评测：{statusLabel(value.result?.evaluation_status)} · 归档：
              {statusLabel(value.result?.archive_status)}
            </p>
            <p>
              清理完成：{known(value.result?.cleanup_complete)} · 租约释放：
              {known(value.result?.lease_released)}
            </p>
            <p>类型：{value.kind}</p>
            {value.lineage.project_id && (
              <a href={`#projects/${value.lineage.project_id}`}>查看所属项目</a>
            )}
            {value.kind === "experiment" &&
              ["accepted", "running"].includes(value.state) && (
                <div className="actions">
                  <button
                    type="button"
                    disabled={
                      busy ||
                      value.cancel_requested ||
                      !capabilities.data?.run_control
                    }
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await request(token, `${path}/cancel`, {});
                        run.refresh();
                      } catch (reason) {
                        setError(String(reason));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {value.cancel_requested
                      ? "正在取消，等待清理…"
                      : "取消运行"}
                  </button>
                </div>
              )}
            {value.kind !== "experiment" &&
              !["finished", "quarantined"].includes(value.state) && (
                <p className="muted">
                  长期环境 / Planner 请通过 research close、environment cancel
                  或 planner stop 结束。
                </p>
              )}
            {!capabilities.data?.run_control && (
              <p>{capabilities.data?.controller_reason}</p>
            )}
          </Panel>
          {Boolean(value.jobs?.length) && (
            <Panel title="容器内 Job">
              {value.jobs?.map((job) => (
                <p key={job.job_id}>
                  {job.job_id} · Job：{statusLabel(job.state)} · exit code：
                  {job.exit_code ?? "—"}
                </p>
              ))}
            </Panel>
          )}
          <ArtifactFiles token={token} path={path} />
          <ExecutionEvents
            key={path}
            token={token}
            path={path}
            poll={run.data?.state !== "finished"}
          />
        </>
      )}
    </>
  );
}

function finished(run: ControlRun) {
  return run.state === "finished";
}
