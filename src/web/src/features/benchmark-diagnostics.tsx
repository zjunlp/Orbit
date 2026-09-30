import { useState } from "react";
import { useData } from "../api/console";
import {
  Badge,
  Empty,
  Notice,
  Panel,
  statusVariant,
} from "../components/common";

import { BenchmarkTrajectoryPanel } from "./benchmark-trajectory";

interface BenchmarkRun {
  run_id: string;
  state: string;
  benchmark: string;
  unit_id: string;
  candidate_id: string;
  execution: string | null;
  evaluation: string | null;
  protocol: string | null;
  cleanup_complete: boolean | null;
  resources: {
    requested: unknown;
    authorized: unknown;
    actual_allocation: unknown;
    usage: unknown;
  };
}
interface CampaignCandidate {
  candidate_id: string;
  parent_id: string | null;
  state: string;
  score: number | null;
  run_id: string | null;
  feedback: Record<string, number> | null;
}
interface Campaign {
  campaign_id: string;
  state: string;
  stop_reason: string | null;
  selected_candidate_id: string | null;
  candidates: CampaignCandidate[];
}
interface Compatibility {
  adapter_id: string;
  adapter_version: string;
  suite_digest: string;
  runner_digest: string;
  profile: string;
  backend: string;
  agent: string;
  agent_version: string;
  model: string;
  level: string;
  official_submission: string;
  evidence: string[];
  limitations: string[];
}
interface BenchmarkSnapshot {
  available: boolean;
  capacity: { max_concurrent: number } | null;
  active_leases: number;
  queued: number;
  runs: BenchmarkRun[];
  campaigns: Campaign[];
  compatibility: Compatibility[];
}

export function BenchmarkDiagnostics({ token }: { token: string }) {
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const { data, error, refresh, updated } = useData<BenchmarkSnapshot>(
    token,
    "benchmarks",
    5000,
  );
  return (
    <>
      <div className="section-line">
        <p className="muted">
          本机管理员视图，每 5 秒读取持久状态。不会启动任务或读取私有评测文件。
        </p>
        <button type="button" onClick={refresh}>
          刷新
        </button>
      </div>
      <Notice error={error} loading={!data} />
      {data && !data.available && (
        <Empty>尚无 Benchmark 状态。先通过 CLI 规划和提交一次 trial。</Empty>
      )}
      {data?.available && (
        <>
          <div className="stats">
            <Panel title="队列等待">
              <strong className="metric">{data.queued}</strong>
            </Panel>
            <Panel title="活动租约">
              <strong className="metric">{data.active_leases}</strong>
            </Panel>
            <Panel title="授权并发">
              <strong className="metric">
                {data.capacity?.max_concurrent ?? "—"}
              </strong>
              <small>仅为调度准入，不等于容器硬限额</small>
            </Panel>
          </div>
          <Panel title="最近 Benchmark 运行">
            {data.runs.length === 0 ? (
              <Empty>暂无运行。</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Run / Candidate</th>
                      <th>任务</th>
                      <th>执行 / 评测 / 协议</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((run) => (
                      <tr key={run.run_id}>
                        <td>
                          <strong>{run.candidate_id}</strong>
                          <small>{run.run_id}</small>
                          {run.benchmark === "ASI-Bench" && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedRun(run.run_id);
                              }}
                            >
                              查看轨迹
                            </button>
                          )}
                        </td>
                        <td>
                          {run.benchmark}
                          <small>{run.unit_id}</small>
                        </td>
                        <td>
                          {run.execution ?? "—"} / {run.evaluation ?? "—"} /{" "}
                          {run.protocol ?? "—"}
                        </td>
                        <td>
                          <Badge variant={statusVariant(run.state)}>
                            {run.state}
                          </Badge>
                          <small>
                            清理：
                            {run.cleanup_complete === true ? "确认" : "待确认"}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <small>
              仅显示最近 50 条；原始日志和完整 Records 请用管理员 CLI 查询。
            </small>
          </Panel>
          {selectedRun && (
            <BenchmarkTrajectoryPanel
              key={selectedRun}
              token={token}
              runId={selectedRun}
              onClose={() => setSelectedRun(null)}
            />
          )}
          <Panel title="Campaign 候选比较">
            {data.campaigns.length === 0 ? (
              <Empty>暂无 Campaign；候选创建与提交仍使用 benchmark CLI。</Empty>
            ) : (
              data.campaigns.map((campaign) => (
                <div className="event" key={campaign.campaign_id}>
                  <div className="section-line">
                    <strong>{campaign.campaign_id}</strong>
                    <Badge variant={statusVariant(campaign.state)}>
                      {campaign.state}
                    </Badge>
                  </div>
                  <p className="muted">
                    当前选择：{campaign.selected_candidate_id ?? "未选出"} ·
                    停止原因：
                    {campaign.stop_reason ?? "—"}
                  </p>
                  {campaign.candidates.map((candidate) => (
                    <div className="section-line" key={candidate.candidate_id}>
                      <span>
                        {candidate.candidate_id}
                        {candidate.parent_id
                          ? ` ← ${candidate.parent_id}`
                          : " (baseline)"}
                      </span>
                      <span>
                        {candidate.state} · 分数 {candidate.score ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </Panel>
          <Panel title="兼容性证据矩阵">
            {data.compatibility.length === 0 ? (
              <Empty>
                尚无已发布的兼容性声明；请通过 CLI 发布带证据的矩阵。
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>适配器 / Profile</th>
                      <th>Agent / Backend</th>
                      <th>级别</th>
                      <th>提交</th>
                      <th>证据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.compatibility.map((entry) => (
                      <tr
                        key={`${entry.adapter_id}:${entry.adapter_version}:${entry.suite_digest}:${entry.runner_digest}:${entry.profile}:${entry.agent}:${entry.agent_version}:${entry.model}:${entry.backend}`}
                      >
                        <td>
                          {entry.adapter_id} {entry.adapter_version}
                          <small>{entry.profile}</small>
                        </td>
                        <td>
                          {entry.agent}
                          <small>
                            {entry.model} · {entry.backend}
                          </small>
                        </td>
                        <td>{entry.level}</td>
                        <td>{entry.official_submission}</td>
                        <td>{entry.evidence.length} 条引用</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <small>刷新于 {updated || "—"}。兼容性声明不代表官方认证。</small>
        </>
      )}
    </>
  );
}
