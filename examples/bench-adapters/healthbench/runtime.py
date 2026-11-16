"""Execute the original HealthBench rubric evaluator in a separate container."""

import sys

from judged import run

if __name__ == "__main__":
    run("healthbench", sys.argv[1])
