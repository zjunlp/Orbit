"""Derived metric series are bounded, repeatable and never index private evaluation."""

import json
from datetime import UTC, datetime

from agent_infra.records.api import (
    AttemptManifest,
    DataClass,
    ProducerKind,
    RecordContext,
    RunManifest,
    Visibility,
)
from agent_infra.records.local import LocalRecordsStore
from agent_infra.records.metrics import MetricIndex


def test_metric_index_replay_invalid_lines_and_sampling(tmp_path):
    records = LocalRecordsStore(tmp_path / "records")
    now = datetime.now(UTC)
    records.begin_run(RunManifest("run", now, {}))
    records.begin_attempt(AttemptManifest("attempt", "run", now))
    sink = records.scoped_sink(RecordContext("run", "attempt", "test", ProducerKind.RUN))
    path = tmp_path / "metrics.jsonl"
    path.write_text(
        "".join(json.dumps({"step": step, "loss": 1 / (step + 1)}) + "\n" for step in range(20))
        + "{broken\n"
        + '{"loss":0.4,"bad":"not numeric"}\n'
        + json.dumps({"overflow": 10**400})
        + "\n"
        + '{"name":"speed","value":2,"unit":"items/s"}\n'
    )
    artifact = sink.commit_artifact(path, name="metrics", visibility=Visibility.USER)
    index = MetricIndex(records)
    index.index(artifact)
    first = index.read("run", max_points=5)
    index.index(artifact)
    assert index.read("run", max_points=5) == first
    loss = first["series"][0]
    assert loss["count"] == 20 and loss["downsampled"] and len(loss["points"]) <= 5
    assert loss["points"][0]["step"] == 0 and loss["points"][-1]["step"] == 19
    assert len(first["issues"]) == 3
    assert first["series"][1]["unit"] == "items/s"
    private = sink.commit_artifact(
        path,
        name="private",
        visibility=Visibility.CONTROLLER,
        data_class=DataClass.PRIVATE_EVALUATION,
    )
    index.index(private)
    assert index.read("run", max_points=5) == first
    reopened = MetricIndex(LocalRecordsStore(records.root, read_only=True))
    assert reopened.read("run", max_points=5) == first
