"""Export the pinned RLinf CALVIN sequence list without importing training dependencies."""

import ast
import contextlib
import json
from math import pi
from pathlib import Path
import runpy
import sys
from types import ModuleType

import numpy as np
from omegaconf import OmegaConf
import pyhash


def main():
    root = Path("/opt/calvin")
    source = root / "agent/calvin_agent/evaluation/utils.py"
    # The native helpers only need NumPy and pyhash. The module also imports training code.
    utility = ModuleType("calvin_agent.evaluation.utils")
    utility.__dict__.update(np=np, pi=pi, contextlib=contextlib, hasher=pyhash.fnv1_32())
    functions = {"temp_seed", "get_env_state_for_initial_condition"}
    definitions = [node for node in ast.parse(source.read_text()).body
                   if isinstance(node, ast.FunctionDef) and node.name in functions]
    if {node.name for node in definitions} != functions:
        raise ValueError("pinned CALVIN evaluation helpers are missing")
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source), "exec"), utility.__dict__)
    sys.modules[utility.__name__] = utility

    generator = runpy.run_path(str(root / "rlinf_sequences.py"))["get_sequences"]
    prompts = OmegaConf.load(root / "agent/conf/annotations/new_playtable_validation.yaml")
    indices, states, sequences = {}, [], []
    for initial, chain in generator(1000, num_workers=4):
        key = tuple(initial.values())
        if key not in indices:
            indices[key] = len(states)
            states.append([array.tolist() for array in utility.get_env_state_for_initial_condition(initial)])
        sequences.append((indices[key], list(chain)))
    instructions = {task: str(prompts[task][0]) for _, chain in sequences for task in chain}
    print(json.dumps({"states": states, "sequences": sequences, "instructions": instructions},
                     separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
