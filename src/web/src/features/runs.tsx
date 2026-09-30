import { useState } from "react";
import {
  type Artifact,
  type Attempt,
  known,
  pretty,
  type Run,
  useData,
} from "../api/console";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  statusVariant,
} from "../components/common";
import { ExecutionRecent } from "./execution";
import { ExecutionEvents } from "./execution-events";

function AttemptView({ token, attempt }: { token: string; attempt: Attempt }) {
  const path = `attempts/${encodeURIComponent(attempt.id)}`;
  const artifacts = useData<{ items: Artifact[] }>(token, `${path}/artifacts`);
  return (
    <>
      <div className="stats">
        <Panel title="执行状态">
          <Badge variant={statusVariant(attempt.status)}>
            {attempt.status}
          </Badge>
          <p>评测：{attempt.evaluation_status ?? "未记录"}</p>
        </Panel>
        <Panel title="清理状态">
          <p>清理完成：{known(attempt.cleanup_complete)}</p>
          <p>租约已释放：{known(attempt.lease_released)}</p>
        </Panel>
        <Panel title="采集范围">
          <pre>{pretty(attempt.coverage)}</pre>
        </Panel>
      </div>
      <ExecutionEvents token={token} path={path} />
      <Panel title="产物索引">
        <Notice error={artifacts.error} />
        {artifacts.data?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>大小</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>
                      {item.kind} · {item.media_type}
                    </td>
                    <td>{item.size_bytes.toLocaleString()} B</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>暂无公开产物索引。</Empty>
        )}
        <p className="muted">
          首版展示元数据；原始轨迹、完整日志与产物下载尚未开放。
        </p>
      </Panel>
    </>
  );
}
function RunDetail({ token, id }: { token: string; id: string }) {
  const detail = useData<{ id: string; status: string; attempts: Attempt[] }>(
    token,
    `runs/${encodeURIComponent(id)}`,
    5000,
  );
  const [selected, setSelected] = useState("");
  const attempt =
    detail.data?.attempts.find((item) => item.id === selected) ??
    detail.data?.attempts[0];
  return (
    <>
      <div className="section-line">
        <h2 className="break">{id}</h2>
        <a href="#runs">← 全部运行</a>
      </div>
      <Notice error={detail.error} loading={!detail.data} />
      {detail.data && (
        <label>
          Attempt
          <select
            value={attempt?.id ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {detail.data.attempts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {attempt ? (
        <AttemptView key={attempt.id} token={token} attempt={attempt} />
      ) : (
        detail.data && <Empty>这次运行还没有 Attempt 记录。</Empty>
      )}
    </>
  );
}
export function RunsPage({
  token,
  id,
  records = false,
}: {
  token: string;
  id?: string;
  records?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const runs = useData<{ items: Run[]; next_offset: number | null }>(
    token,
    id ? null : `runs?offset=${offset}`,
    5000,
  );
  if (id) return <RunDetail key={id} token={token} id={id} />;
  return (
    <>
      <ExecutionRecent token={token} />
      <Panel title={records ? "按运行检索执行证据" : "运行列表"}>
        <p className="muted">
          {records
            ? "进入一次运行，查看 Attempt、事件轨迹、采集范围与产物索引。"
            : "每 5 秒刷新。执行、评测和清理分别记录；执行完成不代表评测通过。"}
        </p>
        <Notice error={runs.error} loading={!runs.data} />
        {runs.data?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>状态</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.items.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <a href={`#runs/${encodeURIComponent(run.id)}`}>
                        {run.id} ↗
                      </a>
                    </td>
                    <td>
                      <Badge variant={statusVariant(run.status)}>
                        {run.status}
                      </Badge>
                    </td>
                    <td>{new Date(run.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            当前 Records 目录尚无运行。请确认启动服务时的 --records-root
            指向已有执行记录。
          </Empty>
        )}
        <div className="actions">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 100))}
          >
            上一页
          </button>
          <button
            type="button"
            disabled={runs.data?.next_offset == null}
            onClick={() => setOffset(runs.data?.next_offset ?? 0)}
          >
            下一页
          </button>
          <small>每页最多 100 条 · {runs.updated || "—"}</small>
        </div>
      </Panel>
    </>
  );
}
