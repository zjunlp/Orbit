"""Private HTTP tool transport over a per-trial Unix socket."""

from http.client import HTTPConnection
import json
import os
from pathlib import Path
import socket
from socketserver import UnixStreamServer
import sys

SOCKET = "/ipc/tools.sock"


class Connection(HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def request(route, payload=None, timeout=120):
    connection = Connection("localhost", timeout=timeout)
    try:
        connection.request("GET" if payload is None else "POST", "/" + route,
                           body=None if payload is None else json.dumps(payload).encode(),
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        raw = response.read()
        if response.status != 200:
            raise RuntimeError(f"Tool service returned HTTP {response.status}: {response.reason}")
        return json.loads(raw)
    finally:
        connection.close()


def serve(handler):
    with UnixStreamServer(SOCKET, handler) as server:
        os.chmod(SOCKET, 0o666)
        server.serve_forever()


def ipc_mount(staging):
    path = Path(staging) / "ipc"
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o777)
    return {"source": str(path), "target": "/ipc", "mode": "rw"}


if __name__ == "__main__":
    request("info", timeout=2)
    sys.exit(0)
