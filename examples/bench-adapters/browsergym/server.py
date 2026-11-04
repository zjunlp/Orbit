"""BrowserGym backend of the shared single-episode GUI service."""
from pathlib import Path
import sys

from episode import BrowserGymBackend, shared
from evidence import read

Bridge = shared.Bridge
RequestError = shared.RequestError
handler = shared.handler


def serve(plan, output, port=8765):
    return shared.serve(plan, output, BrowserGymBackend(read(plan)), port)


if __name__ == "__main__":
    sys.exit(serve(Path(sys.argv[1]), Path(sys.argv[2])))
