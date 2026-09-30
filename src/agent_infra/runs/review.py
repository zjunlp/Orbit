"""Read-only experiment views over durable commands and authorized Records artifacts."""

import json
from collections.abc import Callable
from typing import Any

from agent_infra.runs.query import RunQueries
from agent_infra.runs.review_api import CodeView, ExperimentReview, MetricsView


class ExperimentReviews:
    def __init__(self, queries: RunQueries, metrics: Callable[[str], dict[str, Any]]) -> None:
        self.queries, self.metrics = queries, metrics

    def get(self, run_id: str) -> ExperimentReview:
        run = self.queries.commands.get(run_id)
        request, lineage = run["request"], run["lineage"]
        source = request.get("code", {})
        code = CodeView(
            digest=source.get("digest"),
            commit=source.get("commit"),
            source_snapshot=source.get("path"),
        )
        issues: list[str] = []
        if run.get("index_error"):
            issues.append(
                "Derived metrics could not be indexed; original artifacts remain available."
            )
        if request.get("kind") == "command":
            for artifact in self.queries.artifacts(run_id):
                manifest = self.queries.artifact(run_id, artifact["artifact_id"])
                for member in manifest["files"]:
                    name = member["path"]
                    if name not in {
                        "outputs/.infra-evidence/code.json",
                        "outputs/.infra-evidence/code.patch",
                    }:
                        continue
                    view = self.queries.artifact_view(
                        run_id, artifact["artifact_id"], name, format="text", limit=65536
                    )
                    if name.endswith("code.patch"):
                        code.patch, code.patch_truncated = view["text"], view["truncated"]
                    elif view["truncated"]:
                        issues.append(
                            "Source manifest exceeds the preview limit; use the archived member."
                        )
                    else:
                        try:
                            metadata = json.loads(view["text"])
                            code.files = metadata["files"]
                            code.excluded = metadata["excluded"]
                        except (ValueError, TypeError, KeyError):
                            issues.append("Source manifest preview is unavailable.")
        result = run.get("result") or {}
        return ExperimentReview(
            run_id=run_id,
            project_id=lineage.get("project_id"),
            name=lineage.get("name") or lineage.get("experiment_id") or run_id,
            state=run["state"],
            execution=result.get("execution", result.get("execution_status", result.get("status"))),
            capture=result.get("capture", result.get("archive_status")),
            created_at=run["created_at"],
            parent_run_id=lineage.get("parent_run_id"),
            request=request.get("command"),
            image_id=request.get("image_id"),
            code=code,
            metrics=MetricsView.model_validate(self.metrics(run_id)),
            issues=issues,
        )
