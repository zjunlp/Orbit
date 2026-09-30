"""Read-only benchmark projection for the local administrator console."""

from dataclasses import asdict
from pathlib import Path
from typing import Any

from agent_infra.benchmarks.compatibility import read_matrix
from agent_infra.bootstrap.benchmark_workspace import BenchmarkWorkspace
from agent_infra.bootstrap.node_resources import list_node_leases
from agent_infra.projects.benchmark_campaign import BenchmarkCampaignService, BenchmarkCampaignStore
from agent_infra.records.local import LocalRecordsStore
from agent_infra.resources.persistent import PersistentLeaseStore
from agent_infra.runs.benchmark_evidence import BenchmarkEvidence
from agent_infra.runs.control_store import RunControlStore


class BenchmarkConsole:
    def __init__(self, state_root: Path) -> None:
        self.root = state_root / "benchmarks"
        self.workspace = BenchmarkWorkspace(state_root)

    @staticmethod
    def _run(item: dict[str, Any]) -> dict[str, Any]:
        execution = item["request"]["execution"]
        plan = execution["frozen_plan"]["plan"]
        result = item.get("result") or {}
        accounting = result.get("resource_accounting") or {}
        return {
            "run_id": item["run_id"],
            "attempt_id": item["attempt_id"],
            "state": item["state"],
            "created_at": item["created_at"],
            "benchmark": plan["suite"]["benchmark"],
            "unit_id": plan["units"][0]["unit_id"],
            "candidate_id": plan["request"]["candidate"]["candidate_id"],
            "adapter": execution["frozen_plan"]["adapter"]["adapter_id"],
            "execution": result.get("execution"),
            "evaluation": result.get("evaluation"),
            "protocol": result.get("protocol"),
            "cleanup_complete": result.get("cleanup_complete"),
            "resources": {
                "requested": accounting.get("requested"),
                "authorized": accounting.get("authorized"),
                "actual_allocation": accounting.get("actual_allocation"),
                "usage": accounting.get("usage"),
            },
        }

    def snapshot(self) -> dict[str, Any]:
        control = self.root / "control.sqlite3"
        if not control.is_file():
            return {
                "available": False,
                "capacity": None,
                "active_leases": 0,
                "queued": 0,
                "runs": [],
                "campaigns": [],
                "compatibility": [],
            }
        store = RunControlStore(self.root, read_only=True)
        runs = store.list_runs(limit=50)
        lease_root = self.root / "leases"
        leases = (
            PersistentLeaseStore(lease_root, read_only=True)
            if (lease_root / "leases.sqlite3").is_file()
            else None
        )
        campaigns_root = self.root / "campaigns"
        campaigns = (
            BenchmarkCampaignService(
                BenchmarkCampaignStore(campaigns_root, read_only=True)
            ).list_campaigns()
            if (campaigns_root / "campaigns.sqlite3").is_file()
            else []
        )
        matrix_path = self.root / "compatibility.json"
        matrix = (
            read_matrix(matrix_path).model_dump(mode="json")["entries"]
            if matrix_path.is_file()
            else []
        )
        observed_leases = (leases.list() if leases else ()) + list_node_leases(self.root)
        return {
            "available": True,
            "capacity": asdict(leases.capacity) if leases else None,
            "active_leases": len(
                {item.lease_id for item in observed_leases if item.state.value != "released"}
            ),
            "queued": len(store.queued()),
            "runs": [self._run(item) for item in runs],
            "campaigns": campaigns,
            "compatibility": matrix,
        }

    def trajectory(self, run_id: str, *, cursor: int = 0, limit: int = 50) -> dict[str, Any]:
        """Read a bounded native view from the run's own immutable Records artifact."""
        if not 0 <= cursor <= 100000 or not 1 <= limit <= 100:
            raise ValueError("invalid trajectory page")
        run = RunControlStore(self.root, read_only=True).get(run_id)
        plan = run["request"]["execution"]["frozen_plan"]["plan"]
        result = run.get("result") or {}
        native = result.get("native_result") or {}
        evidence = native.get("evidence") or {}
        identity = {
            "run_id": run_id,
            "attempt_id": run["attempt_id"],
            "instance_id": native.get("instance_id") or plan["units"][0]["native_id"],
            "prompt_level": native.get("prompt_level"),
            "session_id": (evidence.get("trajectory") or {}).get("session_id"),
        }
        base = {
            **identity,
            "capture_status": evidence.get("capture_status", "unavailable"),
            "trajectory": evidence.get("trajectory") or {"capture_status": "unavailable"},
            "docker": evidence.get("docker") or {},
            "files": evidence.get("files") or {},
            "calls": evidence.get("calls") or {},
            "steps": [],
            "next_cursor": None,
        }
        artifact_id = result.get("artifact_id")
        if not artifact_id or not evidence:
            return base
        records_path = self.root / "records" / "records.sqlite3"
        if not records_path.is_file():
            return base
        records = LocalRecordsStore(self.root / "records", read_only=True)
        return BenchmarkEvidence(records, run).trajectory(cursor=cursor, limit=limit)

    def workspace_route(
        self, method: str, parts: list[str], query: dict[str, list[str]], body: dict[str, Any]
    ) -> dict[str, Any]:
        return self.workspace.route(method, parts, query, body)
