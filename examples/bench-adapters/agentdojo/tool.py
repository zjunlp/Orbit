"""Subject-side client: exposes native tools without mounting private benchmark code."""

import json
import sys
from tool_socket import request as socket_request


def request(route, payload=None):
    print(json.dumps(socket_request(route, payload, timeout=30), ensure_ascii=False))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "info":
        request("info")
    elif mode == "call":
        request("call", {"function": sys.argv[2], "args": json.loads(sys.argv[3])})
    elif mode == "finish":
        request("finish", {"answer": sys.argv[2]})
    elif mode == "baseline":
        request("baseline", {"mode": sys.argv[2]})
    else:
        raise ValueError("Use info, call, finish or baseline")
