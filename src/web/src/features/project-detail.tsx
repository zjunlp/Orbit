import { useState } from "react";
import { type Project, request, useData } from "../api/console";
import type { Capabilities, ProjectDetail } from "../api/workflow";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  statusVariant,
} from "../components/common";
import { ExecutionList } from "./execution";
import { ProjectExperiments } from "./experiment-review";
import { ExperimentSubmit } from "./experiment-submit";
import { ProjectSessions } from "./project-sessions";

function WorkspaceBinding({
  token,
  id,
  refresh,
}: {
  token: string;
  id: string;
  refresh: () => void;
}) {
  const projects = useData<{ items: Project[] }>(token, "projects");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Panel title="工作区未绑定">
      <p>
        旧项目的目标、里程碑和关联均保留。可先通过“新建项目”或 CLI
        创建工作区，再明确绑定。这里不会自动创建目录或合并研究内容。
      </p>
      <label>
        已有工作区
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">请选择</option>
          {projects.data?.items
            .filter((p) => p.source === "workspace")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.workspace}
              </option>
            ))}
        </select>
      </label>
      <Notice error={error || projects.error} />
      <button
        type="button"
        disabled={busy || !selected}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await request(token, `projects/${encodeURIComponent(id)}/bind`, {
              project_id: selected,
            });
            refresh();
          } catch (reason) {
            setError(String(reason));
          } finally {
            setBusy(false);
          }
        }}
      >
        确认关联此工作区
      </button>
    </Panel>
  );
}
export function ProjectDetailPage({
  token,
  id,
}: {
  token: string;
  id: string;
}) {
  const detail = useData<ProjectDetail>(
    token,
    `projects/${encodeURIComponent(id)}`,
    5000,
  );
  const capabilities = useData<Capabilities>(token, "capabilities", 10000);
  const data = detail.data;
  const document = data?.research?.document;
  return (
    <>
      <div className="section-line">
        <h2>{data?.project.name ?? "项目详情"}</h2>
        <a href="#projects">← 全部项目</a>
      </div>
      <Notice error={detail.error} loading={!data} />
      {data && (
        <>
          <Notice error={data.research_warning} />
          <Panel title="项目概况">
            <Badge variant={statusVariant(data.project.status)}>
              项目：{data.project.status}
            </Badge>
            <p className="prewrap">{data.project.goal}</p>
            <p className="break">
              工作区：{data.project.workspace ?? "未绑定"}
            </p>
            <p>绑定 / 初始化：{data.project.binding_status}</p>
            {data.project.task_mappings?.map((item) => (
              <p className="break" key={item.key}>
                旧任务 {item.key} →{" "}
                {item.identity
                  ? `${item.identity.task_id} @ ${item.identity.revision.slice(0, 12)}`
                  : "身份未知"}{" "}
                ·{" "}
                {item.resolved ? "已解析" : "待处理：需重新注册或核对任务版本"}
              </p>
            ))}
            {data.project.run_ids.map((run) => (
              <p key={run}>
                <a href={`#runs/${encodeURIComponent(run)}`}>旧运行：{run}</a>
              </p>
            ))}
          </Panel>
          {!data.project.workspace_project_id && (
            <WorkspaceBinding token={token} id={id} refresh={detail.refresh} />
          )}
          {document && (
            <Panel title="研究背景与方案">
              <p>
                当前版本 {data.research?.research_revision} · 已采用版本{" "}
                {data.research?.accepted_revision ?? "无"}
              </p>
              {data.research?.unaccepted_changes && (
                <p role="status">
                  有尚未采用的修改。执行仍使用下面明确显示的已采用版本。
                </p>
              )}
              {data.research?.projection_pending && (
                <p role="status">工作区文档投影待恢复；请通过 CLI 检查。</p>
              )}
              <h3>{document.brief.question || "尚未形成研究问题"}</h3>
              <p className="prewrap">{document.brief.background}</p>
              <p>成功标准：{document.brief.success_criteria || "待补充"}</p>
              {document.brief.constraints.map((item) => (
                <p key={item}>约束：{item}</p>
              ))}
              <h3>待澄清的问题</h3>
              {document.brief.unknowns.length ? (
                <ul>
                  {document.brief.unknowns.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : (
                <p>没有登记的未知项。</p>
              )}
              <p className="prewrap">{document.plan.summary}</p>
              {document.plan.experiments.map((e) => (
                <details key={e.id}>
                  <summary>
                    {e.title} · {e.id}
                  </summary>
                  <p>假设：{e.hypothesis}</p>
                  <p>方法：{e.method}</p>
                  <p>停止条件：{e.stopping_condition}</p>
                  <p>产物：{e.outputs.join("、")}</p>
                </details>
              ))}
              <p>
                下一步：
                {document.next_step ||
                  "通过 Agent / CLI 完善方案，再确认采用。"}
              </p>
            </Panel>
          )}
          {data.accepted && data.research?.accepted_revision && (
            <ExperimentSubmit
              key={`${id}:${data.research.accepted_revision}`}
              token={token}
              projectId={id}
              revision={data.research.accepted_revision}
              experiments={data.accepted.research.document.plan.experiments}
              compiledTasks={data.compiled_tasks}
              capabilities={capabilities.data}
            />
          )}
          {data.project.workspace_project_id && !data.accepted && (
            <Empty>
              可以直接用 run command
              提交已有代码，无需先保存研究方案。研究方案、确认与 Task
              编译仍可按需使用。
            </Empty>
          )}
          <ProjectExperiments
            token={token}
            runs={data.runs}
            canRun={capabilities.data?.run_control ?? false}
          />
          <Panel title="项目运行">
            <ExecutionList runs={data.runs} />
            <p className="muted">
              显示最近 100 次；项目进度、Run 执行状态与容器 Job 状态分别记录。
            </p>
          </Panel>
          <Panel title="结果分析">
            {!data.analyses.length && (
              <Empty>暂无分析。Agent / CLI 保存的证据分析会显示在这里。</Empty>
            )}
            {data.analyses.map((analysis) => (
              <article className="event" key={analysis.analysis_id}>
                <small>{new Date(analysis.created_at).toLocaleString()}</small>
                <h3>观察</h3>
                <p className="prewrap">{analysis.observations}</p>
                <h3>解释</h3>
                <p className="prewrap">{analysis.interpretation}</p>
                <h3>不确定性</h3>
                <p>{analysis.uncertainty}</p>
                <h3>下一步建议</h3>
                <p>{analysis.recommendation}</p>
                {analysis.evidence.map((e, i) => (
                  <div key={`${e.run_id}:${e.member ?? i}`}>
                    <a href={`#execution/${encodeURIComponent(e.run_id)}`}>
                      证据：{e.run_id}
                    </a>
                    {e.member && <p>产物成员：{e.member}</p>}
                    {e.metrics.map((m) => (
                      <p key={m.name}>
                        {m.name} = {m.value} {m.unit} · {m.direction}
                      </p>
                    ))}
                  </div>
                ))}
                <p className="muted">
                  分析是对执行证据的解释，不代表平台已验证科学结论。
                </p>
              </article>
            ))}
          </Panel>
          {data.project.workspace_project_id && (
            <ProjectSessions
              token={token}
              projectId={data.project.workspace_project_id}
            />
          )}
        </>
      )}
    </>
  );
}
