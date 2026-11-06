"""A fixed sequential loop inside one Run; completed episodes are independent sealed evidence."""

from pathlib import Path
import signal

from .binding import digest
from .driver import EpisodeCancelled
from .evidence import write_json


def run_batch(plan, episodes, output, execute):
    if digest({key: value for key, value in plan.items() if key != "digest"}) != plan["digest"]:
        raise ValueError("batch plan digest mismatch")
    if len(episodes) != len(plan["members"]) or not episodes:
        raise ValueError("batch membership mismatch")
    for index, (request, member) in enumerate(zip(episodes, plan["members"])):
        if (request["trialId"] != member["trialId"] or request["episodeId"] != member["episodeId"]
                or request["sample"]["sampleId"] != member["sampleRef"]
                or request["batch"] != {"plan": plan, "index": index}):
            raise ValueError("episode differs from frozen batch membership")
    output = Path(output)
    write_json(output / "batch-plan.json", plan)
    stopped = [False]
    def stop(_signal, _frame):
        stopped[0] = True
    previous = signal.signal(signal.SIGTERM, stop)
    states = ["not_started"] * len(episodes)
    try:
        for index, request in enumerate(episodes):
            if stopped[0]:
                break
            states[index] = "interrupted"
            result = execute(request, output / "episodes" / request["episodeId"], lambda: stopped[0])
            states[index] = "completed" if result["valid"] else "invalid"
            write_json(output / "batch-result.json", {"planDigest": plan["digest"], "states": states})
            if not result["valid"]:
                raise RuntimeError("batch stopped after invalid episode; no stateful call was retried")
    except EpisodeCancelled:
        stopped[0] = True
    finally:
        write_json(output / "batch-result.json", {"planDigest": plan["digest"], "states": states,
                                                  "cancelled": stopped[0]})
        signal.signal(signal.SIGTERM, previous)
