"""Compatibility import for saved BrowserGym evidence and staged runtimes."""
from importlib import import_module
from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().parent.parent.parent / "tools"))
_shared = import_module("orbit-gui-service.evidence")
for _name in dir(_shared):
    if not _name.startswith("_"):
        globals()[_name] = getattr(_shared, _name)

if __name__ == "__main__":
    _shared.main()
