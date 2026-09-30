import { useState } from "react";
import {
  type Project,
  type Run,
  request,
  type Task,
  useData,
} from "../api/console";
import type { Capabilities } from "../api/workflow";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  statusVariant,
} from "../components/common";
import { ProjectCreate } from "./project-create";

const blank = (): Project => ({
  revision: 0,
  name: "",
  goal: "",
  status: "planned",
  milestones: [],
  run_ids: [],
  task_keys: [],
});
const statuses = {
  planned: "计划中",
  active: "进行中",
  blocked: "有阻塞",
  completed: "已完成",
  archived: "已归档",
};
export function ProjectsPage({ token }: { token: string }) {
  const capabilities = useData<Capabilities>(token, "capabilities");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const projects = useData<{ items: Project[] }>(token, "projects");
  const tasks = useData<{ items: Task[] }>(token, "tasks");
  const runs = useData<{ items: Run[] }>(token, "runs");
  const [draft, setDraft] = useState<Project | null>(null);
  const [milestone, setMilestone] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!draft) return;
    setBusy(true);
    setMessage("");
    try {
      await request(token, "projects", {
        id: draft.id,
        revision: draft.revision,
        name: draft.name,
        goal: draft.goal,
        status: draft.status,
        milestones: draft.milestones,
        run_ids: draft.run_ids,
        task_keys: draft.task_keys,
      });
      setDraft(null);
      projects.refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  const edit = (project: Project) => {
    setDraft(structuredClone(project));
    setMessage("");
    setMilestone("");
  };
  const visible =
    projects.data?.items.filter(
      (project) =>
        `${project.name} ${project.goal}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (!statusFilter || project.status === statusFilter),
    ) ?? [];
  return (
    <>
      <div className="section-line">
        <p className="muted">研究目标、里程碑与执行证据归档。进度由你确认。</p>
        <div className="actions">
          <a href="#runs">查看科研运行 →</a>
          <button
            type="button"
            className="primary"
            disabled={!capabilities.data}
            onClick={() =>
              capabilities.data?.project_workspaces
                ? setCreating(true)
                : edit(blank())
            }
          >
            ＋ 新建项目
          </button>
        </div>
      </div>
      <Notice error={projects.error} loading={!projects.data} />
      {creating && (
        <ProjectCreate
          token={token}
          close={() => {
            setCreating(false);
            projects.refresh();
          }}
        />
      )}
      {draft && (
        <Panel title={draft.id ? "编辑项目" : "新建科研项目"}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="form-grid">
              <label>
                项目名称
                <input
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                状态
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value })
                  }
                >
                  {Object.entries(statuses).map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              研究目标
              <textarea
                maxLength={5000}
                value={draft.goal}
                onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
              />
            </label>
            <label>
              里程碑标题
              <input
                maxLength={200}
                value={milestone}
                onChange={(e) => setMilestone(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={
                !milestone.trim() ||
                draft.milestones.some((m) => m.title === milestone.trim()) ||
                draft.milestones.length >= 100
              }
              onClick={() => {
                setDraft({
                  ...draft,
                  milestones: [
                    ...draft.milestones,
                    { title: milestone.trim(), done: false },
                  ],
                });
                setMilestone("");
              }}
            >
              添加里程碑
            </button>
            {draft.milestones.map((item, i) => (
              <div className="section-line" key={item.title}>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        milestones: draft.milestones.map((m, index) =>
                          index === i ? { ...m, done: e.target.checked } : m,
                        ),
                      })
                    }
                  />
                  {item.title}
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      milestones: draft.milestones.filter(
                        (_, index) => index !== i,
                      ),
                    })
                  }
                >
                  移除
                </button>
              </div>
            ))}
            <div className="form-grid">
              <fieldset>
                <legend>关联已注册任务</legend>
                <Notice error={tasks.error} />
                {tasks.data?.items.map((task) => (
                  <label className="inline" key={task.key}>
                    <input
                      type="checkbox"
                      checked={draft.task_keys.includes(task.key)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          task_keys: e.target.checked
                            ? [...draft.task_keys, task.key]
                            : draft.task_keys.filter((id) => id !== task.key),
                        })
                      }
                    />
                    {task.task_id}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>关联运行（最近 100 条）</legend>
                <Notice error={runs.error} />
                {runs.data?.items.map((run) => (
                  <label className="inline" key={run.id}>
                    <input
                      type="checkbox"
                      checked={draft.run_ids.includes(run.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          run_ids: e.target.checked
                            ? [...draft.run_ids, run.id]
                            : draft.run_ids.filter((id) => id !== run.id),
                        })
                      }
                    />
                    {run.id}
                  </label>
                ))}
              </fieldset>
            </div>
            <Notice error={message} />
            <div className="actions">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存项目"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                取消
              </button>
            </div>
          </form>
        </Panel>
      )}
      {!projects.data?.items.length && !draft && (
        <Empty>
          还没有科研项目。新建项目后，可以记录目标、维护里程碑并关联已有运行。
        </Empty>
      )}
      {!!projects.data?.items.length && (
        <div className="project-filters">
          <label>
            搜索科研项目
            <input
              type="search"
              placeholder="项目名称或研究目标"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            项目状态
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部项目</option>
              {Object.entries(statuses).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <span className="muted">{visible.length} 个项目</span>
        </div>
      )}
      {!!projects.data?.items.length && !visible.length && (
        <Empty>
          没有匹配的项目。
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setStatusFilter("");
            }}
          >
            清除筛选
          </button>
        </Empty>
      )}
      <div className="cards">
        {visible.map((project) => {
          const done = project.milestones.filter((m) => m.done).length;
          return (
            <Panel key={project.id} title={project.name}>
              <Badge variant={statusVariant(project.status)}>
                {statuses[project.status as keyof typeof statuses] ??
                  project.status}
              </Badge>
              <p className="prewrap">{project.goal || "尚未填写研究目标"}</p>
              <p>
                {project.milestones.length
                  ? `里程碑 ${done} / ${project.milestones.length}`
                  : "尚未设置里程碑"}
              </p>
              {project.milestones.length > 0 && (
                <progress
                  aria-label={`${project.name}里程碑完成进度`}
                  max={project.milestones.length}
                  value={done}
                />
              )}
              <p className="muted">
                {project.task_keys.length} 个任务 · {project.run_ids.length}{" "}
                次运行
              </p>
              {project.run_ids.slice(0, 3).map((id) => (
                <a
                  className="run-link"
                  key={id}
                  href={`#runs/${encodeURIComponent(id)}`}
                >
                  {id} ↗
                </a>
              ))}
              {project.run_ids.length > 3 && (
                <details>
                  <summary>其余 {project.run_ids.length - 3} 次运行</summary>
                  {project.run_ids.slice(3).map((id) => (
                    <a
                      key={id}
                      className="run-link"
                      href={`#runs/${encodeURIComponent(id)}`}
                    >
                      {id} ↗
                    </a>
                  ))}
                </details>
              )}
              {project.source && (
                <p className="muted">
                  {project.source === "legacy" ? "旧项目" : "科研工作区"} ·{" "}
                  {project.binding_status === "unbound"
                    ? "未绑定"
                    : project.binding_status}
                </p>
              )}
              {project.source && (
                <p>
                  <a href={`#projects/${encodeURIComponent(project.id ?? "")}`}>
                    查看方案、实验与结果 →
                  </a>
                </p>
              )}
              {project.source !== "workspace" && (
                <button type="button" onClick={() => edit(project)}>
                  编辑项目
                </button>
              )}
            </Panel>
          );
        })}
      </div>
    </>
  );
}
