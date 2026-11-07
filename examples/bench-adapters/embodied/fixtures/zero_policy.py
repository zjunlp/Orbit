"""Explicit stateless calibration policy; never a real VLA positive or reference reproduction."""

import hashlib
from http import HTTPStatus

import numpy as np
from openpi_client import msgpack_numpy
from websockets.sync.server import serve


IDENTITY = {
    "checkpointDigest": "sha256:" + hashlib.sha256(b"orbit-zero-calibration:50x7:float32:v1").hexdigest(),
    "normalizationDigest": "sha256:" + hashlib.sha256(b"identity-normalization:v1").hexdigest(),
    "randomness": {"backend": "stateless", "scope": "stateless"},
}


def health(connection, request):
    if request.path == "/healthz":
        return connection.respond(HTTPStatus.OK, "calibration policy ready\n")


def handler(connection):
    connection.send(msgpack_numpy.packb({"orbit": IDENTITY, "calibration": True}))
    for message in connection:
        request = msgpack_numpy.unpackb(message)
        if request["observation/state"].shape != (8,):
            raise ValueError("calibration fixture expects the declared eight-element state")
        connection.send(msgpack_numpy.packb({"actions": np.zeros((50, 7), dtype=np.float32)}))


if __name__ == "__main__":
    with serve(handler, "0.0.0.0", 8000, process_request=health) as server:
        server.serve_forever()
