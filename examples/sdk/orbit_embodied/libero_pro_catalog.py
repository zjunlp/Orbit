"""LIBERO-PRO registration metadata shared with the native driver."""

from .libero_suites import SUITES


MODES = {"object": "Object", "swap": "Position", "lan": "Language", "task": "Task", "env": "Environment"}
SCOPES = tuple((suite, mode) for suite in SUITES for mode in MODES)
TASK_ROOT = "/opt/libero-pro/generated"
INITIAL_STATES = 50
