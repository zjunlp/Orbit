"""Deterministic action conversions shared by Solve and CPU Verify."""

LIBERO_GRIPPER = "libero-gripper"
LIGHTNAV_HSSD_VELOCITY = "lightnav-hssd-velocity/1"


def connector_action_conversion(connector, io_adapter=None):
    if connector == "openvla-ws" or (connector == "groot-zmq" and io_adapter == "libero-native"):
        return LIBERO_GRIPPER
    return None


def libero_gripper(chunk):
    """Model gripper in [0, 1] (1 opens) to LIBERO's -1 open / +1 close."""
    import numpy as np

    chunk = np.asarray(chunk)
    if chunk.ndim != 2 or chunk.shape[1] != 7 or chunk.dtype.kind not in "buif" or not np.isfinite(chunk).all():
        raise ValueError("LIBERO gripper conversion requires finite numeric 7D raw actions")
    converted = np.array(chunk, dtype=np.result_type(chunk.dtype, np.float32), copy=True)
    converted[:, -1] = -np.sign(2 * converted[:, -1] - 1)
    return converted


def lightnav_hssd_velocity(chunk):
    """Project [normalized linear velocity, normalized angular velocity, decoded] to one Habitat action."""
    import numpy as np

    chunk = np.asarray(chunk)
    if chunk.shape != (1, 3) or chunk.dtype.kind not in "iuf":
        raise ValueError("expected one LightNav velocity and decode status")
    linear, angular, decoded = chunk[0]
    if not np.isfinite(chunk).all() or not (-1 <= linear <= 1 and -1 <= angular <= 1):
        raise ValueError("LightNav returned a velocity outside the normalized range")
    if decoded not in (0, 1) or (decoded == 0 and (linear, angular) != (-1, 0)):
        raise ValueError("invalid LightNav decode status or fallback velocity")
    forward = (linear + 1) / 2
    if max(forward, abs(angular)) < 0.5:
        action = 0
    elif forward >= abs(angular):
        action = 1
    else:
        action = 2 if angular > 0 else 3
    return np.array([[action]], dtype=np.int32)


CONVERSIONS = {LIBERO_GRIPPER: libero_gripper, LIGHTNAV_HSSD_VELOCITY: lightnav_hssd_velocity}
