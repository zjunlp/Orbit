import { useEffect, useState } from "react";
import {
  type Agent,
  known,
  type Project,
  pretty,
  type Run,
  type Task,
  useData,
} from "./api/console";
import { Badge, Empty, Notice, Panel } from "./components/common";
import { BenchmarksPage } from "./features/benchmarks";
import { ExecutionDetail } from "./features/execution";
import { ProjectDetailPage } from "./features/project-detail";
import { ProjectsPage } from "./features/projects";
import { ResourcesPage } from "./features/resources";
import { RunsPage } from "./features/runs";

const navigation = [
  ["benchmarks", "实验", "▤"],
  ["projects", "科研项目", "◇"],
  ["resources", "资源", "▥"],
  ["settings", "设置", "⚙"],
];
const secondaryPages: Record<
  string,
  { title: string; section: "projects" | "settings" }
> = {
  overview: { title: "总览", section: "settings" },
  tasks: { title: "注册任务", section: "settings" },
  runs: { title: "科研运行", section: "projects" },
  execution: { title: "科研运行", section: "projects" },
  agents: { title: "Agent 配置", section: "settings" },
  records: { title: "运行记录", section: "settings" },
};
function readToken() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    sessionStorage.setItem("console-token", token);
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#benchmarks`,
    );
  }
  return token ?? sessionStorage.getItem("console-token") ?? "";
}
function Overview({ token }: { token: string }) {
  const projects = useData<{ items: Project[] }>(token, "projects", 10000);
  const runs = useData<{ items: Run[] }>(token, "runs", 5000);
  const tasks = useData<{ items: Task[] }>(token, "tasks");
  return (
    <>
      <div className="hero">
        <span className="eyebrow">YOUR RESEARCH WORKSPACE</span>
        <h2>让每一次探索，都有迹可循。</h2>
        <p>连接任务、Agent 与执行环境，集中查看研究进展和运行证据。</p>
        <a href="#projects">管理科研项目 →</a>
      </div>
      <Notice error={projects.error || runs.error || tasks.error} />
      <div className="stats">
        <Panel title="科研项目">
          <strong className="metric">
            {projects.data?.items.length ?? "—"}
          </strong>
          <p>持续维护目标和里程碑</p>
        </Panel>
        <Panel title="已注册任务">
          <strong className="metric">{tasks.data?.items.length ?? "—"}</strong>
          <p>启动时明确注册的任务包</p>
        </Panel>
        <Panel title="最近运行">
          <strong className="metric">{runs.data?.items.length ?? "—"}</strong>
          <p>最近 100 条记录的窗口</p>
        </Panel>
      </div>
      <Panel title="最近执行">
        {runs.data?.items.slice(0, 5).map((run) => (
          <div className="section-line" key={run.id}>
            <a href={`#runs/${encodeURIComponent(run.id)}`}>{run.id}</a>
            <Badge>{run.status}</Badge>
          </div>
        ))}
        {runs.data?.items.length === 0 && (
          <Empty>
            暂无执行记录。先创建研究项目，或连接已有的 Records 目录。
          </Empty>
        )}
      </Panel>
      <Panel title="本机资源">
        <p className="muted">
          资源页持续显示 CPU、内存与 GPU
          实测数据，并保留本次服务会话的短期趋势。
        </p>
        <a href="#resources">查看实时资源 →</a>
      </Panel>
    </>
  );
}
function TasksPage({ token }: { token: string }) {
  const { data, error } = useData<{ items: Task[] }>(token, "tasks");
  return (
    <>
      <p className="muted">
        这里只展示注册科研任务的公开描述。Benchmark 中的任务请从实验详情查看。
      </p>
      <Notice error={error} loading={!data} />
      {data?.items.length === 0 && (
        <Empty>
          没有注册任务。启动命令可重复添加 --task path/to/task.yaml。
        </Empty>
      )}
      {data?.items.map((task) => (
        <Panel key={task.key} title={task.task_id}>
          <Notice error={task.error} />
          <Badge>{task.mode ?? "无法解析"}</Badge>
          <p>评测配置：{task.evaluation ?? "未知"}</p>
          <details>
            <summary>Agent 可见描述、输入和工具声明</summary>
            <pre>{pretty(task.view)}</pre>
          </details>
          <details>
            <summary>资源要求</summary>
            <pre>{pretty(task.resource_intent)}</pre>
          </details>
        </Panel>
      ))}
    </>
  );
}
function AgentsPage({ token }: { token: string }) {
  const { data, error, refresh } = useData<{ items: Agent[] }>(token, "agents");
  return (
    <>
      <div className="section-line">
        <p className="muted">
          只探测本机安装与认证状态；不会安装软件或发起模型请求。探测结果缓存 60
          秒。
        </p>
        <button type="button" onClick={refresh}>
          重新读取
        </button>
      </div>
      <Notice error={error} loading={!data} />
      <div className="cards">
        {data?.items.map((agent) => (
          <Panel title={agent.name} key={agent.provider}>
            <Badge>{agent.provider}</Badge>
            <dl>
              <dt>已安装</dt>
              <dd>{known(agent.available)}</dd>
              <dt>已认证</dt>
              <dd>{known(agent.authenticated)}</dd>
              <dt>版本</dt>
              <dd>{agent.version || "未知"}</dd>
              <dt>版本兼容</dt>
              <dd>{known(agent.compatible)}</dd>
            </dl>
            <p className="muted">{agent.capabilities.join(" · ")}</p>
            {agent.issues.map((issue) => (
              <p key={issue} className="error">
                {issue}
              </p>
            ))}
            <small>探测于 {new Date(agent.checked_at).toLocaleString()}</small>
          </Panel>
        ))}
      </div>
    </>
  );
}
function Settings({ token }: { token: string }) {
  const capabilities = useData<unknown>(token, "capabilities");
  return (
    <>
      <div className="settings-links">
        {[
          ["agents", "Agent 配置", "查看安装版本与认证状态"],
          ["records", "运行记录", "查询历史轨迹和产物"],
          ["tasks", "注册任务", "查看科研任务输入与资源要求"],
          ["overview", "项目总览", "查看项目、任务与近期执行"],
        ].map(([key, title, description]) => (
          <a href={`#${key}`} key={key}>
            <strong>{title} →</strong>
            <small>{description}</small>
          </a>
        ))}
      </div>
      <Panel title="本机控制台">
        <p>
          当前为单管理员、单节点控制台。服务只监听
          127.0.0.1，访问令牌随服务重启更换。
        </p>
        <p>
          访问令牌仅保存在当前标签页的
          sessionStorage；退出会清除。远程使用请通过 SSH 本地端口转发。
        </p>
        <p>
          工作区项目与 Controller 共用 --state-dir；旧项目保存在 --console-dir。
          --records-root 可额外指定旧运行记录；--task 注册旧任务。
        </p>
        <p>
          可初始化项目、查看研究方案、提交已采用实验、取消运行并查看产物和分析。
          执行需要启动同一状态目录下的
          Controller；暂不提供聊天、集群管理或多人权限。
        </p>
        <Notice error={capabilities.error} />
        <details>
          <summary>服务能力</summary>
          <pre>{pretty(capabilities.data)}</pre>
        </details>
      </Panel>
    </>
  );
}
export function App() {
  const [token, setToken] = useState(readToken);
  const [input, setInput] = useState("");
  const [route, setRoute] = useState(location.hash.slice(1) || "benchmarks");
  useEffect(() => {
    const changed = () => {
      // Login links may change only the fragment of an already mounted page.
      setToken(readToken());
      setRoute(location.hash.slice(1) || "benchmarks");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  if (!token)
    return (
      <main className="login">
        <span className="eyebrow">AGENT INFRA</span>
        <h1>连接你的研究空间</h1>
        <p>打开服务启动时显示的访问链接，或输入本机控制台令牌。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem("console-token", input.trim());
            setToken(input.trim());
          }}
        >
          <label>
            访问令牌
            <input
              type="password"
              required
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <button className="primary" type="submit">
            连接控制台
          </button>
        </form>
      </main>
    );
  const [page, id] = route.split("?")[0].split("/");
  const active = navigation.find(
    ([key]) => key === (secondaryPages[page]?.section ?? page),
  );
  return (
    <div className="shell">
      <button
        type="button"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳到主要内容
      </button>
      <aside className="sidebar">
        <a className="brand" href="#benchmarks">
          <span className="brand-mark">ai</span>
          <span>
            Agent Infra<small>RESEARCH CONSOLE</small>
          </span>
        </a>
        <p className="nav-label">工作空间</p>
        <nav aria-label="主导航">
          {navigation.map(([key, label, icon]) => (
            <a
              key={key}
              className={key === active?.[0] ? "active" : ""}
              aria-current={key === active?.[0] ? "page" : undefined}
              href={`#${key}`}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="dot" /> 本机管理员
          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem("console-token");
              setToken("");
              setInput("");
            }}
          >
            退出连接
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <div>
            <h1>
              {secondaryPages[page]?.title ?? active?.[1] ?? "页面不存在"}
            </h1>
          </div>
          <span className="muted">本机研究工作台</span>
        </header>
        <main key={page} id="main-content" tabIndex={-1}>
          {page === "overview" && <Overview token={token} />}
          {page === "projects" &&
            (id ? (
              <ProjectDetailPage
                key={id}
                token={token}
                id={decodeURIComponent(id)}
              />
            ) : (
              <ProjectsPage token={token} />
            ))}
          {page === "execution" && id && (
            <ExecutionDetail
              key={id}
              token={token}
              id={decodeURIComponent(id)}
            />
          )}
          {page === "resources" && <ResourcesPage token={token} />}
          {page === "benchmarks" && (
            <BenchmarksPage token={token} route={route} />
          )}
          {page === "tasks" && <TasksPage token={token} />}
          {page === "agents" && <AgentsPage token={token} />}
          {(page === "runs" || page === "records") && (
            <RunsPage token={token} id={id} records={page === "records"} />
          )}
          {page === "settings" && <Settings token={token} />}
          {!active && !secondaryPages[page] && (
            <Empty>
              <a href="#benchmarks">返回实验列表</a>
            </Empty>
          )}
        </main>
        <footer>
          Agent Infra · 研究进展由里程碑表达，执行结果以持久记录为准。
        </footer>
      </div>
    </div>
  );
}
