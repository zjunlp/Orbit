"""Shared bounded policy payloads; object arrays and pickle are prohibited."""

import io

import numpy as np


def pack(value):
    import msgpack
    import msgpack_numpy

    def encode(item):
        if isinstance(item, np.ndarray) and item.dtype.hasobject:
            raise ValueError("object arrays are not supported by the policy transport")
        return msgpack_numpy.encode(item)
    return msgpack.packb(value, default=encode)


def unpack(value):
    import msgpack
    import msgpack_numpy

    def decode(item):
        if item.get(b"nd", item.get("nd")) and item.get(b"kind", item.get("kind")) in (b"O", "O"):
            raise ValueError("object arrays are not supported by the policy transport")
        if item.get("__ndarray_class__", item.get(b"__ndarray_class__")):
            return np.load(io.BytesIO(item.get("as_npy", item.get(b"as_npy"))), allow_pickle=False)
        return msgpack_numpy.decode(item)
    return msgpack.unpackb(value, object_hook=decode, raw=False)


async def serve_actions(policy, metadata, host, port):
    import asyncio
    from http import HTTPStatus
    from websockets.exceptions import ConnectionClosed
    from websockets.server import serve

    async def health(path, _headers):
        if path == "/healthz":
            return HTTPStatus.OK, [("Content-Type", "text/plain")], b"OK\n"

    async def handler(connection):
        await connection.send(pack(metadata))
        try:
            async for message in connection:
                if not isinstance(message, bytes):
                    raise ValueError("policy requests must be binary")
                actions = policy(unpack(message))
                await connection.send(pack({"actions": actions}))
        except ConnectionClosed:
            return
        except Exception as exc:
            await connection.send(type(exc).__name__ + ": " + str(exc))
            await connection.close(code=1011, reason="policy inference failed")

    async with serve(handler, host, port, compression=None, max_size=64 * 1024 * 1024,
                     process_request=health):
        await asyncio.Future()
