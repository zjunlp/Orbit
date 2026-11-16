"""HTTP over the per-trial Unix socket; the agent container has no network."""
import http.client
import json
import os
import socket


class Connection(http.client.HTTPConnection):
    def __init__(self, path=None, timeout=180):
        super().__init__('localhost', timeout=timeout)
        self.path = path or os.environ.get('HLE_SOCKET', '/hle-ipc/gateway.sock')

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def call(path, data):
    conn = Connection()
    try:
        conn.request('POST', path, json.dumps(data).encode(), {'Content-Type': 'application/json'})
        response = conn.getresponse()
        body = json.loads(response.read())
        if response.status != 200:
            raise ValueError(body.get('error', 'Gateway request failed'))
        return body
    finally:
        conn.close()
