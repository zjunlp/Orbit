"""Shared bounded policy payloads; object arrays and pickle are prohibited."""

import io

import numpy as np

POLICY_FALLBACKS = ("none", "empty-plan", "invalid-plan")
POLICY_WS_MAX_MESSAGE_SIZE = 64 * 1024 * 1024


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


def _pack_rejection(reason, actions):
    if actions.dtype.kind in "buif" and actions.nbytes < POLICY_WS_MAX_MESSAGE_SIZE:
        response = pack({"rejection": {"reason": reason, "actions": actions}})
        if len(response) <= POLICY_WS_MAX_MESSAGE_SIZE:
            return response
    summary = {"dtype": str(actions.dtype), "shape": list(actions.shape), "preview": repr(actions)[:500]}
    return pack({"rejection": {"reason": reason, "summary": summary}})


def checked_policy_actions(raw, action_size, replan_steps, *, action_count=None, dtype=None):
    from .driver import EpisodeFailure
    from .evidence import validate_action_chunk

    try:
        actions = np.asarray(raw)
    except ValueError:
        actions = np.asarray(raw, dtype=object)
    try:
        validate_action_chunk(actions, action_size, replan_steps)
        if len(actions) != (action_count if action_count is not None else replan_steps):
            raise ValueError("policy action count differs from the released model")
        if dtype is None:
            return actions
        with np.errstate(over="ignore"):
            native = actions.astype(dtype)
        if not np.isfinite(native).all():
            raise ValueError("policy action chunk has non-finite values after conversion to " + str(native.dtype))
        return native
    except ValueError as exc:
        raise EpisodeFailure("policy_act", str(exc), rejected_actions=actions) from exc


def serve_frozen_actions(build, asset_groups, action_size, replan_steps, randomness, *,
                         action_count=None, normalization_digest=None):
    import argparse
    import asyncio
    import json
    from pathlib import Path

    from .assets import policy_asset_digests

    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--asset-digests", type=json.loads, required=True)
    args = parser.parse_args()
    identities = policy_asset_digests(args.weights, asset_groups)
    if normalization_digest is not None:
        identities["normalizationDigest"] = normalization_digest()
    if identities != args.asset_digests:
        raise ValueError("policy assets differ from the frozen registration")
    infer, reset = build(args.weights)

    def act(observation):
        return checked_policy_actions(infer(observation), action_size, replan_steps, action_count=action_count)

    metadata = {"actionSize": action_size, "replanSteps": replan_steps,
                "orbit": {**identities, "randomness": randomness}}
    asyncio.run(serve_actions(act, metadata, "0.0.0.0", 8000, reset=reset))


async def serve_actions(policy, metadata, host, port, *, reset=None, report_fallback=False):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from http import HTTPStatus
    from websockets.exceptions import ConnectionClosed
    from websockets.server import serve

    from .driver import EpisodeFailure

    async def health(path, _headers):
        if path == "/healthz":
            return HTTPStatus.OK, [("Content-Type", "text/plain")], b"OK\n"

    episode = asyncio.Lock()
    loop = asyncio.get_running_loop()

    def predict(message, reset_episode):
        if reset_episode:
            reset()
        prediction = policy(unpack(message))
        if report_fallback:
            actions, fallback = prediction
            return pack({"actions": actions, "fallback": fallback})
        return pack({"actions": prediction})

    async def handler(connection):
        if reset is not None:
            await episode.acquire()
        try:
            await connection.send(pack(metadata))
            first = True
            async for message in connection:
                if not isinstance(message, bytes):
                    raise ValueError("policy requests must be binary")
                response = await loop.run_in_executor(worker, predict, message, first and reset is not None)
                first = False
                await connection.send(response)
        except ConnectionClosed:
            return
        except Exception as exc:
            if isinstance(exc, EpisodeFailure) and exc.rejected_actions is not None:
                await connection.send(_pack_rejection(str(exc), np.asarray(exc.rejected_actions)))
            else:
                await connection.send(type(exc).__name__ + ": " + str(exc))
            await connection.close(code=1011, reason="policy inference failed")
        finally:
            if reset is not None:
                episode.release()

    # Keep the socket responsive during synchronous model calls and serialize the model's state.
    with ThreadPoolExecutor(max_workers=1) as worker:
        async with serve(handler, host, port, compression=None, max_size=POLICY_WS_MAX_MESSAGE_SIZE,
                         ping_interval=None if reset is not None else 20, process_request=health):
            await asyncio.Future()
