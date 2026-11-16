"""Subject-side client: exposes native tools without mounting private benchmark code."""

import json
import sys
import urllib.request


def request(route, payload=None):
    req = urllib.request.Request("http://tools:8080/" + route,
                                 data=json.dumps(payload).encode() if payload is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.load(response)
    print(json.dumps(result, ensure_ascii=False))


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
