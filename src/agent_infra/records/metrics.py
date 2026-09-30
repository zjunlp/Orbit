"""Rebuildable metric index over immutable, user-visible artifact members."""

import json
import math
from contextlib import closing
from pathlib import PurePosixPath
from typing import Any

from agent_infra.records.api import ArtifactRef, BlobRef
from agent_infra.records.local import LocalRecordsStore
from agent_infra.records.visibility import artifact_visible


class MetricIndex:
    def __init__(self, records: LocalRecordsStore) -> None:
        self.records = records

    def index(self, artifact: ArtifactRef) -> None:
        if self.records.read_only:
            raise ValueError("metric indexing requires a writable Records store")
        if not artifact_visible(artifact.data_class, artifact.visibility):
            return
        with closing(self.records._connect()) as db:
            identity = db.execute(
                "SELECT run_id FROM artifacts WHERE artifact_id=?", (artifact.artifact_id,)
            ).fetchone()
            if identity is None:
                raise KeyError(artifact.artifact_id)
            run_id = identity[0]
        with self.records.open_blob(artifact.manifest_blob) as stream:
            manifest = json.load(stream)
        rows: list[tuple[Any, ...]] = []
        issues: list[str] = []
        for member in manifest["files"]:
            if PurePosixPath(member["path"]).name != "metrics.jsonl":
                continue
            ref = BlobRef(**member["blob"])
            if ref.size_bytes > 16 * 1024**2:
                issues.append(f"{member['path']}: exceeds 16 MiB metric indexing limit")
                continue
            with self.records.open_blob(ref) as stream:
                for number, raw in enumerate(stream, 1):
                    if number > 100000:
                        issues.append(f"{member['path']}: indexing stopped after 100000 lines")
                        break
                    try:
                        item = json.loads(raw)
                        if not isinstance(item, dict):
                            raise ValueError("metric line must be an object")
                        step = item.get("step", number)
                        if type(step) not in (int, float) or not math.isfinite(step):
                            raise ValueError("invalid step")
                        entries = (
                            {item["name"]: item["value"]}
                            if "name" in item and "value" in item
                            else {
                                key: value
                                for key, value in item.items()
                                if key not in {"step", "unit", "timestamp"}
                            }
                        )
                        if not entries or len(entries) > 100:
                            raise ValueError("a metric line must contain 1–100 values")
                        unit = item.get("unit", "")
                        if not isinstance(unit, str) or len(unit) > 128:
                            raise ValueError("invalid metric unit")
                        parsed = []
                        for name, value in entries.items():
                            if not isinstance(name, str) or not name or len(name) > 200:
                                raise ValueError("invalid metric name")
                            if type(value) not in (int, float) or not math.isfinite(value):
                                raise ValueError("metric values must be finite numbers")
                            parsed.append(
                                (
                                    run_id,
                                    artifact.artifact_id,
                                    member["path"],
                                    number,
                                    name,
                                    unit,
                                    float(step),
                                    float(value),
                                )
                            )
                        if len(rows) + len(parsed) > 100000:
                            issues.append(
                                f"{member['path']}: artifact exceeds 100000 indexed values"
                            )
                            break
                        rows.extend(parsed)
                    except (ValueError, KeyError, TypeError, UnicodeError, OverflowError) as error:
                        if len(issues) < 100:
                            issues.append(f"{member['path']}:{number}: {error}")
        with self.records._lock, closing(self.records._connect()) as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS metric_index (run_id TEXT, artifact_id TEXT, "
                "member TEXT, line INTEGER, name TEXT, unit TEXT, step REAL, value REAL, "
                "PRIMARY KEY(artifact_id,member,line,name))"
            )
            db.execute("CREATE INDEX IF NOT EXISTS metric_run ON metric_index(run_id,name,unit)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS metric_index_sources "
                "(artifact_id TEXT PRIMARY KEY, run_id TEXT, issues TEXT)"
            )
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM metric_index WHERE artifact_id=?", (artifact.artifact_id,))
            db.executemany("INSERT INTO metric_index VALUES (?,?,?,?,?,?,?,?)", rows)
            db.execute(
                "INSERT OR REPLACE INTO metric_index_sources VALUES (?,?,?)",
                (artifact.artifact_id, run_id, json.dumps(issues)),
            )
            db.commit()

    def read(self, run_id: str, *, max_points: int = 1000) -> dict[str, Any]:
        if not 2 <= max_points <= 10000:
            raise ValueError("metric page size must be 2–10000")
        with closing(self.records._connect()) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='metric_index'").fetchone():
                return {"series": [], "issues": [], "indexed": False}
            grouped = db.execute(
                "SELECT name,unit,COUNT(*) AS count FROM metric_index WHERE run_id=? "
                "GROUP BY name,unit ORDER BY name,unit",
                (run_id,),
            ).fetchall()
            series = []
            for group in grouped:
                points = db.execute(
                    "SELECT step,value,artifact_id,member,line FROM metric_index "
                    "WHERE run_id=? AND name=? AND unit=? ORDER BY step,line,artifact_id",
                    (run_id, group["name"], group["unit"]),
                ).fetchall()
                count = len(points)
                stride = max(1, math.ceil((count - 1) / (max_points - 1)))
                selected = points[::stride]
                if points and selected[-1] != points[-1]:
                    selected.append(points[-1])
                series.append(
                    {
                        "name": group["name"],
                        "unit": group["unit"],
                        "count": count,
                        "points": [dict(row) for row in selected],
                        "downsampled": len(selected) < count,
                    }
                )
            sources = db.execute(
                "SELECT issues FROM metric_index_sources WHERE run_id=?", (run_id,)
            ).fetchall()
            return {
                "series": series,
                "issues": [issue for row in sources for issue in json.loads(row[0])],
                "indexed": bool(sources),
            }
