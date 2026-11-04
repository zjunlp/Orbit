"""Zero-action policy server (negative calibration): every step returns zeros of the action dim."""

import argparse
import logging

import numpy as np

from vla_eval.model_servers.base import Row
from vla_eval.model_servers.predict import PredictModelServer
from vla_eval.model_servers.serve import serve


class ZeroPolicy(PredictModelServer):
    def __init__(self, action_dim: int = 7, **kw):
        super().__init__(max_batch_size=1, **kw)
        self.action_dim = action_dim

    def predict(self, obs: dict, row: Row) -> dict:
        return {"actions": np.zeros(self.action_dim, dtype=np.float32)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--action-dim", type=int, default=7)
    a = p.parse_args()
    logging.basicConfig(level=logging.INFO)
    serve(ZeroPolicy(action_dim=a.action_dim), host="0.0.0.0", port=a.port)


if __name__ == "__main__":
    main()
