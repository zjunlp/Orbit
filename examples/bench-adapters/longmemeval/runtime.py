"""Execute the original LongMemEval category-specific judgment in a separate container."""

import sys

from judged import run

if __name__ == "__main__":
    run("longmemeval", sys.argv[1])
