"""Explicit stateless calibration fixture speaking the GR00T transport; no model inference."""

import argparse
import json
import os
from pathlib import Path

import numpy as np
import zmq

from orbit_embodied.groot import pack, unpack


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--definition", type=Path)
    args = parser.parse_args()
    definition = json.loads(args.definition.read_text() if args.definition else os.environ["ORBIT_CALIBRATION_POLICY"])
    if definition["kind"] != "calibration" or definition["randomness"]["backend"] != "stateless":
        raise ValueError("this fixture must be registered explicitly as stateless calibration")
    order = definition["profile"]["action"]["order"]
    modalities = {}
    for modality in ("video", "state", "language"):
        fields = [name for name, value in definition["profile"]["observations"].items()
                  if (value["dtype"] == "string" if modality == "language" else name.startswith(modality + "."))]
        modalities[modality] = {"modality_keys": fields if modality == "language" else [name.split(".", 1)[1] for name in fields],
                               "delta_indices": [0]}
    modalities["action"] = {"modality_keys": order, "delta_indices": list(range(16))}
    identity = {key: definition[key] for key in ("checkpointDigest", "normalizationDigest", "randomness")}
    with zmq.Context() as context, context.socket(zmq.REP) as socket:
        socket.bind("tcp://0.0.0.0:" + str(definition["port"]))
        while True:
            request = unpack(socket.recv())
            endpoint = request["endpoint"]
            if endpoint == "ping":
                result = {"status": "ok"}
            elif endpoint == "orbit_identity":
                result = {"calibration": True, "orbit": identity}
            elif endpoint == "get_modality_config":
                result = modalities
            elif endpoint == "reset":
                result = {}
            elif endpoint == "get_action":
                result = [{"action." + key: np.full((1, 16, 1), 1.0 if key == "gripper" else 0.0, dtype=np.float32)
                           for key in order}, {}]
            else:
                result = {"error": "unknown fixture endpoint"}
            socket.send(pack(result))


if __name__ == "__main__":
    main()
