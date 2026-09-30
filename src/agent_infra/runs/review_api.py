"""Versioned, validated DTOs for experiment review; source of generated Web types."""

from pydantic import BaseModel, ConfigDict, Field

from agent_infra.runs.command_api import CommandRequest


class ReviewModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", allow_inf_nan=False, json_schema_serialization_defaults_required=True
    )


class MetricPoint(ReviewModel):
    step: float
    value: float
    artifact_id: str
    member: str
    line: int


class MetricSeries(ReviewModel):
    name: str
    unit: str
    count: int
    points: list[MetricPoint]
    downsampled: bool


class MetricsView(ReviewModel):
    series: list[MetricSeries] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)
    indexed: bool = False


class CodeView(ReviewModel):
    digest: str | None = None
    commit: str | None = None
    files: list[str] = Field(default_factory=list)
    excluded: list[str] = Field(default_factory=list)
    patch: str | None = None
    patch_truncated: bool = False
    source_snapshot: str | None = None


class ExperimentReview(ReviewModel):
    schema_version: str = "1"
    source: str = "controller"
    run_id: str
    project_id: str | None
    name: str
    state: str
    execution: str | None
    capture: str | None
    created_at: str
    parent_run_id: str | None
    request: CommandRequest | None
    image_id: str | None
    code: CodeView
    metrics: MetricsView
    issues: list[str] = Field(default_factory=list)


class SessionSummary(ReviewModel):
    provider: str
    session_id: str
    parent_session_id: str | None
    started_at: str
    records_run_id: str
    records_attempt_id: str
    captured_lines: int
    capture_status: str = "partial"


class SessionList(ReviewModel):
    project_id: str
    sessions: list[SessionSummary]
