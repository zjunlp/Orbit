"""Pinned Chartography loader, no-tools Inspect solver, and original judge."""
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import sys

REVISION = "3f1bf837232d3918c2cc35c6e2418c9e70d2a57b"


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False))


def samples():
    from chartography.dataset import load_samples
    return list(load_samples(task_pack="/pack"))


def pack_digest(root):
    files = sorted(p for p in Path(root).rglob("*") if p.is_file())
    digest = hashlib.sha256()
    for p in files:
        digest.update(str(p.relative_to(root)).encode() + b"\0")
        digest.update(hashlib.sha256(p.read_bytes()).digest())
    return digest.hexdigest()


async def grade(sample, response, plan):
    from chartography.scorer import golden_answer_scorer
    from inspect_ai.model import ModelOutput
    from inspect_ai.scorer import Target
    from inspect_ai.solver import TaskState
    state = TaskState(model=plan["model"] or "empty", sample_id=sample.id, epoch=1,
                      input=sample.input, messages=[], metadata=sample.metadata)
    state.output = ModelOutput.from_content(plan["model"] or "empty", response)
    result = await golden_answer_scorer(plan["judgeModel"])(state, Target(sample.target))
    value = result.value["accuracy"]
    if not math.isfinite(value) or value not in (0, 1):
        raise ValueError("Original judge returned an unscored/invalid result")
    return {"score": value, "explanation": result.explanation, "metadata": result.metadata}


def main():
    output = Path(os.environ["ORBIT_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    mode = sys.argv[1]
    rows = samples()
    digest = pack_digest("/pack")
    if mode == "catalog":
        write(output / "catalog.json", {"revision": REVISION, "packSha256": digest,
              "tasks": [{"id": str(s.id), "title": s.metadata["prompt"],
                         "domain": str(s.metadata.get("domain_combined") or "unknown")} for s in rows]})
        print(f"Loaded {len(rows)} original Chartography samples")
        return
    plan = json.loads(Path("/plan.json").read_text())
    try:
        if digest != plan["packSha256"]:
            raise ValueError("Task pack changed after registration")
        sample = next(s for s in rows if str(s.id) == plan["task"])
        if mode == "solve":
            if plan["method"] in ("empty", "oracle"):
                response = "" if plan["method"] == "empty" else sample.target
            else:
                from inspect_ai import Task, eval
                from inspect_ai.model import get_model
                from inspect_ai.solver import generate
                if not os.environ.get("CHARTOGRAPHY_MODEL_API_KEY"):
                    raise ValueError("CHARTOGRAPHY_MODEL_API_KEY is required")
                model = get_model(plan["model"], base_url=plan["baseUrl"], api_key=os.environ["CHARTOGRAPHY_MODEL_API_KEY"])
                logs = eval(Task(dataset=[sample], solver=generate()), model=model, score=False,
                            log_dir=str(output / "inspect"), max_connections=1, display="none",
                            **({"reasoning_effort": plan["effort"]} if plan.get("effort") else {}))
                if len(logs) != 1 or logs[0].status != "success" or len(logs[0].samples or []) != 1:
                    raise ValueError("Native Inspect solver failed")
                row = logs[0].samples[0]
                if row.error or row.output is None:
                    raise ValueError("Native sample has no valid model response")
                response = row.output.completion
            write(output / "response.json", {"task": plan["task"], "packSha256": digest,
                  "revision": REVISION, "response": response})
        elif mode == "verify":
            raw = Path("/solve/response.json").read_bytes()
            response = json.loads(raw)
            if (response.get("task") != plan["task"] or response.get("packSha256") != digest
                    or response.get("revision") != REVISION):
                raise ValueError("Response identity mismatch")
            result = asyncio.run(grade(sample, response["response"], plan))
            result.update(task=plan["task"], packSha256=digest, revision=REVISION,
                          responseSha256=hashlib.sha256(raw).hexdigest(), judgeModel=plan["judgeModel"])
            write(output / "verdict.json", result)
        else:
            raise ValueError("Unknown phase")
    except Exception as exc:
        write(output / "verdict.json", {"invalid": True, "error": str(exc)})
        raise


if __name__ == "__main__":
    main()
