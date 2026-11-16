"""Subject-side AppWorld client; only native outputs cross the service boundary."""

import json
from pathlib import Path
import sys
import urllib.request


def request(route, data=None):
    req = urllib.request.Request("http://tools:8080/" + route,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as response:
        print(json.dumps(json.load(response), ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1] == "info":
        request("info")
    elif sys.argv[1] == "execute":
        request("execute", {"code": sys.stdin.read() if sys.argv[2] == "-" else Path(sys.argv[2]).read_text()})
    else:
        raise ValueError("Use info or execute FILE (or - for stdin)")
