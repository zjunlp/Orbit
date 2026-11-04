"""Orbit benchmark adapter SDK (design §9.14, L2): Python stdlib only."""

from .protocol import FAILURE_KINDS, invalid, main, pinned, valid

__all__ = ["FAILURE_KINDS", "invalid", "main", "pinned", "valid"]
