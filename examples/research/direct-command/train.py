"""Small deterministic CPU plumbing demo, not a scientific benchmark or model training."""

import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--learning-rate", type=float, default=0.1)
parser.add_argument("--steps", type=int, default=20)
args = parser.parse_args()
if not 0 < args.learning_rate < 1 or not 1 <= args.steps <= 10000:
    parser.error("learning rate must be in (0, 1); steps must be 1–10000")
output = Path(os.environ.get("INFRA_OUTPUT", "outputs"))
output.mkdir(parents=True, exist_ok=True)
weight, target = 0.0, 3.0
with (output / "metrics.jsonl").open("w") as metrics:
    for step in range(args.steps + 1):
        loss = (weight - target) ** 2
        metrics.write(json.dumps({"step": step, "loss": loss}) + "\n")
        metrics.flush()
        if step < args.steps:
            weight -= args.learning_rate * 2 * (weight - target)
result = {"learning_rate": args.learning_rate, "steps": args.steps, "weight": weight, "loss": loss}
(output / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result), flush=True)
