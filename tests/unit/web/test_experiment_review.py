"""HTTP review and rerun scopes retain provenance without changing benchmark rules."""

from tests.unit.web.test_workflow import call
from tests.web.review_fixture import review_fixture


def test_review_metrics_code_rerun_and_sessions(tmp_path):
    with review_fixture(tmp_path) as app:
        first, second = app["first"], app["second"]
        first_review = call(app, f"execution/runs/{first}/review")
        assert first_review[0] == 200, first_review
        view = first_review[1]
        assert view["source"] == "controller"
        assert view["metrics"]["series"][0]["count"] == 5
        assert "train.py" in view["code"]["files"]
        compared = call(app, f"execution/runs/{second}/review")[1]
        assert (
            compared["parent_run_id"] == first
            and compared["code"]["digest"] != view["code"]["digest"]
        )
        status = call(app, f"execution/runs/{second}")[1]
        assert status["result"]["execution_status"] == "completed"
        assert status["result"]["lease_released"]
        path = f"execution/runs/{second}/rerun"
        result = call(app, path, {"operation_id": "review-rerun"})
        assert result[0] == 200, result
        assert call(app, path, {"operation_id": "review-rerun"})[1]["run_id"] == result[1]["run_id"]
        assert (
            call(app, f"execution/runs/{app['finished']}/rerun", {"operation_id": "wrong-kind"})[0]
            == 400
        )
        sessions = call(app, f"projects/{app['project']}/sessions")[1]["sessions"]
        assert sessions[0]["records_run_id"] == app["session"]
        events = call(app, f"projects/{app['project']}/sessions/{app['session']}/events")
        assert events[0] == 200
        assert "录制样例" in str(events[1])
        assert call(app, f"projects/{app['project']}/sessions/not-bound/events")[0] == 404
