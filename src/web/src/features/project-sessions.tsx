import { useState } from "react";
import { useData } from "../api/console";
import type { SessionList } from "../api/review.generated";
import { Empty, Notice, Panel } from "../components/common";
import { ExecutionEvents } from "./execution-events";

export function ProjectSessions({
  token,
  projectId,
}: {
  token: string;
  projectId: string;
}) {
  const endpoint = `projects/${encodeURIComponent(projectId)}/sessions`;
  const sessions = useData<SessionList>(token, endpoint, 10000);
  const [selected, setSelected] = useState("");
  return (
    <>
      <Panel title="宿主机 Agent 会话">
        <Notice error={sessions.error} />
        {!sessions.data?.sessions.length && (
          <Empty>
            尚未绑定。使用 project session discover / bind 选择本项目的 Codex 或
            Claude 会话；目录相同不会自动导入聊天。
          </Empty>
        )}
        {sessions.data?.sessions.map((item) => (
          <div className="run-row" key={item.records_run_id}>
            <button
              type="button"
              onClick={() => setSelected(item.records_run_id)}
              aria-pressed={selected === item.records_run_id}
            >
              {item.provider} · {item.session_id.slice(0, 12)}
              {item.parent_session_id ? " · 子会话" : ""}
            </button>
            <small className="muted">
              已采集 {item.captured_lines} 行 ·{" "}
              {new Date(item.started_at).toLocaleString()}
            </small>
          </div>
        ))}
      </Panel>
      {selected && (
        <ExecutionEvents
          key={selected}
          token={token}
          path={`${endpoint}/${encodeURIComponent(selected)}`}
          poll
          native
        />
      )}
    </>
  );
}
