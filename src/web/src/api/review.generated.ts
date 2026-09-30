/* Generated from runs/review_api.py. Run pnpm contracts; do not edit. */

export type ReviewResponse = ExperimentReview | SessionList;

export interface ExperimentReview {
  schema_version: string;
  source: string;
  run_id: string;
  project_id: string | null;
  name: string;
  state: string;
  execution: string | null;
  capture: string | null;
  created_at: string;
  parent_run_id: string | null;
  request: CommandRequest | null;
  image_id: string | null;
  code: CodeView;
  metrics: MetricsView;
  issues: string[];
}
export interface CommandRequest {
  project: string;
  project_id: string | null;
  name: string;
  image: string;
  argv: string[];
  cwd: string;
  cpu_cores: number;
  memory_bytes: number;
  gpu_device_ids: string[];
  mounts: ReadonlyMount[];
  outputs: string[];
  timeout_seconds: number;
  network: boolean;
  session_id: string | null;
  provider: string | null;
  parent_run_id: string | null;
}
export interface ReadonlyMount {
  source: string;
  target: string;
}
export interface CodeView {
  digest: string | null;
  commit: string | null;
  files: string[];
  excluded: string[];
  patch: string | null;
  patch_truncated: boolean;
  source_snapshot: string | null;
}
export interface MetricsView {
  series: MetricSeries[];
  issues: string[];
  indexed: boolean;
}
export interface MetricSeries {
  name: string;
  unit: string;
  count: number;
  points: MetricPoint[];
  downsampled: boolean;
}
export interface MetricPoint {
  step: number;
  value: number;
  artifact_id: string;
  member: string;
  line: number;
}
export interface SessionList {
  project_id: string;
  sessions: SessionSummary[];
}
export interface SessionSummary {
  provider: string;
  session_id: string;
  parent_session_id: string | null;
  started_at: string;
  records_run_id: string;
  records_attempt_id: string;
  captured_lines: number;
  capture_status: string;
}
