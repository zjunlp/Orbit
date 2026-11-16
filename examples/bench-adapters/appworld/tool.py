"""Subject-side AppWorld client; only native outputs cross the service boundary."""

import json
from pathlib import Path
import sys
from tool_socket import request as socket_request


def request(route, data=None):
    print(json.dumps(socket_request(route, data), ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1] == "info":
        request("info")
    elif sys.argv[1] == "execute":
        request("execute", {"code": sys.stdin.read() if sys.argv[2] == "-" else Path(sys.argv[2]).read_text()})
    else:
        raise ValueError("Use info or execute FILE (or - for stdin)")
