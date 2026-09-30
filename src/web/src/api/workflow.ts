import type { Project } from "./console";

export interface Capabilities {
  project_workspaces?: boolean;
  run_control: boolean;
  artifact_download: boolean;
  controller_reason?: string;
}
export interface Experiment {
  id: string;
  title: string;
  hypothesis: string;
  method: string;
  stopping_condition: string;
  resource_request: string | null;
  outputs: string[];
}
export interface ResearchDocument {
  brief: {
    question: string;
    background: string;
    success_criteria: string;
    constraints: string[];
    unknowns: string[];
  };
  plan: { summary: string; experiments: Experiment[] };
  next_step: string;
}
export interface CompiledTask {
  experiment_id: string;
  research_revision: number;
  research_digest: string;
  task: { task_id: string; revision: string };
}
export interface ControlRun {
  run_id: string;
  attempt_id: string;
  state: string;
  kind?: string;
  created_at: string;
  cancel_requested: boolean;
  lineage: { project_id?: string; experiment_id?: string; name?: string };
  result: {
    status?: string;
    execution_status?: string;
    evaluation_status?: string;
    cleanup_complete?: boolean;
    lease_released?: boolean;
    archive_status?: string;
  } | null;
  jobs?: { job_id: string; state: string; exit_code: number | null }[];
}
export interface Analysis {
  analysis_id: string;
  created_at: string;
  observations: string;
  interpretation: string;
  uncertainty: string;
  recommendation: string;
  evidence: {
    run_id: string;
    artifact_id?: string;
    member?: string;
    metrics: { name: string; value: number; unit: string; direction: string }[];
  }[];
}
export interface ProjectDetail {
  project: Project;
  research_warning?: string;
  research: {
    document: ResearchDocument;
    research_revision: number;
    accepted_revision: number | null;
    accepted_digest: string | null;
    unaccepted_changes: boolean;
    projection_pending: boolean;
  } | null;
  accepted: { research: { document: ResearchDocument } } | null;
  compiled_tasks: CompiledTask[];
  runs: ControlRun[];
  analyses: Analysis[];
}
export interface Preflight {
  ready: boolean;
  issues: unknown[];
  resources?: {
    cpu_cores: number;
    memory_bytes: number;
    gpu: { count: number };
  };
  image_id?: string;
}
