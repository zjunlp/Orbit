#!/bin/sh
set -eu
export PYTHONPATH=/behavior-src/OmniGibson:/behavior-src/bddl3:/behavior-src/joylo:/orbit-embodied/python
exec /opt/conda/envs/behavior/bin/python -s "$@"
