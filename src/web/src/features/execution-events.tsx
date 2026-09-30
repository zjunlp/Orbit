import { useState } from "react";
import { type TraceEvent, useData } from "../api/console";
import { Empty, Notice, Panel } from "../components/common";
import {
  filterTimeline,
  groupTimeline,
  type TimelineFilter,
  timelineDetails,
  timelineStatus,
  timelineSummary,
  timelineTitle,
  timelineTone,
} from "./execution-trace";

function coverageLabel(value: string | undefined): string {
  if (value === "complete") return "完整";
  if (value === "partial") return "部分";
  if (value === "unavailable") return "未采集";
  return "未说明";
}

export function ExecutionEvents({
  token,
  path,
  poll = false,
  native = false,
}: {
  token: string;
  path: string;
  poll?: boolean;
  native?: boolean;
}) {
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [filter, setFilter] = useState<TimelineFilter>("highlights");
  const cursor = pages[pages.length - 1];
  const [search, setSearch] = useState("");
  const events = useData<{
    items: TraceEvent[];
    next_cursor: string | null;
    coverage: Record<string, string>;
  }>(
    token,
    `${path}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    poll ? 5000 : 0,
  );
  const timeline = groupTimeline(events.data?.items ?? []);
  const visible = filterTimeline(timeline, filter).filter((item) =>
    `${timelineTitle(item)} ${item.event.text} ${timelineDetails(item)}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const coverage = events.data?.coverage;
  return (
    <Panel title={native ? "宿主机 Agent 会话" : "平台执行记录"}>
      <p className="muted">
        {native
          ? "从已绑定的原生会话增量采集消息、工具调用和使用量。不代表所有宿主机操作的完整审计。"
          : "查看资源、容器、工具调用和任务状态。默认突出实验节点；切换“全部”可看本页所有公开事件。宿主机会话在项目页单独查看。"}
      </p>
      {coverage && Object.keys(coverage).length > 0 && (
        <p className="muted">
          采集范围：平台工具
          {coverageLabel(coverage.platform_tools)} · 宿主机 Agent
          {coverageLabel(coverage.host_agent)}
        </p>
      )}
      {events.data && (
        <p className="muted">
          第 {pages.length} 页：{events.data.items.length} 条事件合并为{" "}
          {timeline.length} 项；当前显示 {visible.length} 项。
          {poll ? "每 5 秒刷新公开摘要" : "按需刷新公开摘要"}
          {events.updated ? ` · 最近更新 ${events.updated}` : ""}。
        </p>
      )}
      <div className="section-line">
        <label>
          搜索当前页记录
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="操作、错误或消息内容"
          />
        </label>
        <button type="button" onClick={events.refresh}>
          刷新当前页
        </button>
      </div>
      <Notice error={events.error} loading={!events.data} />
      <fieldset className="trace-filters">
        <legend>显示记录</legend>
        {(
          [
            ["highlights", "重点"],
            ["all", "全部"],
            ["tools", "工具调用"],
            ["agent", "Agent"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {visible.map((item) => {
        const tone = timelineTone(item);
        const summary = timelineSummary(item);
        return (
          <article className={`event event-${tone}`} key={item.event.id}>
            <div className="event-heading">
              <strong>{timelineTitle(item)}</strong>
              <span className={`event-status event-status-${tone}`}>
                {timelineStatus(item)}
              </span>
            </div>
            <small title={item.event.at}>
              {new Date(item.event.at).toLocaleString()}
              {summary ? ` · ${summary}` : ""}
            </small>
            {item.event.text && <pre>{item.event.text}</pre>}
            <details>
              <summary>查看事件字段</summary>
              <pre>{timelineDetails(item)}</pre>
            </details>
          </article>
        );
      })}
      {events.data && visible.length === 0 && (
        <Empty>
          {search
            ? "当前筛选中没有匹配的记录，请清除搜索或切换记录范围。"
            : filter === "agent"
              ? "本页没有采集到 Agent 事件；平台操作不等于 Agent 原生轨迹。"
              : filter === "highlights" && timeline.length
                ? "本页只有常规查询事件，可切换“全部”查看。"
                : "本页没有符合条件的公开事件。"}
        </Empty>
      )}
      <div className="actions">
        <button
          type="button"
          disabled={pages.length === 1}
          onClick={() => setPages((current) => current.slice(0, -1))}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={!events.data?.next_cursor}
          onClick={() => {
            const next = events.data?.next_cursor;
            if (next) setPages((current) => [...current, next]);
          }}
        >
          下一页
        </button>
      </div>
    </Panel>
  );
}
