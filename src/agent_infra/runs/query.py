"""Controlled Records reads scoped by durable Run and Artifact identities."""

import base64
import json
from dataclasses import asdict
from typing import Any

from agent_infra.records import AttemptTrajectoryBuilder, BlobRef, EventQuery
from agent_infra.records.api import RecordsReader
from agent_infra.records.visibility import artifact_visible, event_visible
from agent_infra.runs._artifact_view import DEFAULT_PAGE_BYTES, artifact_view, validate_view
from agent_infra.runs.control_store import RunControlStore


class RunQueries:
    def __init__(self, commands: RunControlStore, records: RecordsReader) -> None:
        self.commands, self.records = commands, records

    def read(self, action: str, run_id: str, options: dict[str, Any]) -> dict[str, Any]:
        """One read dispatch shared by project-bound tools and execution transports."""
        if action == "status":
            return self.status(run_id)
        if action == "artifacts":
            return {"items": self.artifacts(run_id)}
        if action == "events":
            return self.events(run_id, options.get("cursor"))
        if action == "trajectory":
            return self.trajectory(run_id)
        if action == "artifact":
            if "format" in options:
                return self.artifact_view(
                    run_id,
                    options["artifact_id"],
                    options.get("member"),
                    format=options["format"],
                    offset=options.get("offset", 0),
                    limit=options.get("limit", DEFAULT_PAGE_BYTES),
                )
            return self.artifact(run_id, options["artifact_id"], options.get("member"))
        raise ValueError("unsupported Run read action")

    def status(self, run_id: str) -> dict[str, Any]:
        entry = self.commands.get(run_id)
        entry["attempts"] = [asdict(item) for item in self.records.list_attempts(run_id)]
        return entry

    def artifacts(self, run_id: str) -> list[dict[str, Any]]:
        entry = self.commands.get(run_id)
        return [
            asdict(item)
            for item in self.records.list_artifacts(entry["attempt_id"])
            if artifact_visible(item.data_class, item.visibility)
        ]

    def _artifact_files(self, run_id: str, artifact_id: str) -> list[dict[str, Any]]:
        allowed = {item["artifact_id"] for item in self.artifacts(run_id)}
        if artifact_id not in allowed:
            raise KeyError(artifact_id)
        artifact = self.records.get_artifact(artifact_id)
        with self.records.open_blob(artifact.manifest_blob) as file:
            manifest = json.load(file)
        return list(manifest["files"])

    @staticmethod
    def _member(files: list[dict[str, Any]], member: str) -> BlobRef:
        # Exact manifest membership, never resolve a caller-supplied host path.
        match = next((item for item in files if item["path"] == member), None)
        if match is None:
            raise KeyError(member)
        return BlobRef(**match["blob"])

    def artifact(self, run_id: str, artifact_id: str, member: str | None = None) -> dict[str, Any]:
        """Legacy whole-file download; retained for HTTP/Web and run artifact --output."""
        files = self._artifact_files(run_id, artifact_id)
        if member is None:
            return {
                "artifact_id": artifact_id,
                "files": [
                    {"path": item["path"], "size_bytes": item["size_bytes"]} for item in files
                ],
            }
        ref = self._member(files, member)
        if ref.size_bytes > 16 * 1024**2:
            raise ValueError("file exceeds 16 MiB HTTP download limit; use local Records storage")
        with self.records.open_blob(ref) as file:
            data = file.read(16 * 1024**2 + 1)
        if len(data) != ref.size_bytes:
            raise ValueError("stored artifact size mismatch")
        return {
            "path": member,
            "size_bytes": len(data),
            "content_base64": base64.b64encode(data).decode(),
        }

    def artifact_view(
        self,
        run_id: str,
        artifact_id: str,
        member: str | None = None,
        *,
        format: str = "auto",
        offset: int = 0,
        limit: int = DEFAULT_PAGE_BYTES,
    ) -> dict[str, Any]:
        """Agent-facing bounded view; no member still lists the authorized manifest."""
        validate_view(format, offset, limit)
        if member is None:
            return self.artifact(run_id, artifact_id)
        ref = self._member(self._artifact_files(run_id, artifact_id), member)
        with self.records.open_blob(ref) as file:
            return artifact_view(
                file,
                ref,
                run_id=run_id,
                artifact_id=artifact_id,
                member=member,
                format=format,
                offset=offset,
                limit=limit,
            )

    def events(self, run_id: str, cursor: str | None = None) -> dict[str, Any]:
        entry = self.commands.get(run_id)
        page = self.records.read_events(EventQuery(attempt_id=entry["attempt_id"]), cursor)
        return {
            "items": [
                asdict(event)
                for event in page.items
                if event_visible(event.data_class, event.visibility)
            ],
            "next_cursor": page.next_cursor,
        }

    def trajectory(self, run_id: str) -> dict[str, Any]:
        entry = self.commands.get(run_id)
        return asdict(AttemptTrajectoryBuilder(self.records).build(entry["attempt_id"]))
