"""LIBERO suite identities shared by registration tools and the native driver."""

SUITES = ("libero_spatial", "libero_object", "libero_goal", "libero_10")
LABELS = {"libero_spatial": "spatial", "libero_object": "object", "libero_goal": "goal",
          "libero_10": "long", "libero_90": "90"}
HORIZONS = {"libero_spatial": 220, "libero_object": 280, "libero_goal": 300,
            "libero_10": 520, "libero_90": 400}


def benchmark_name(suite, *, oft=False):
    prefix = "libero-oft" if oft else "libero"
    suffix = "" if suite == "libero_spatial" else "-" + LABELS[suite]
    return prefix + suffix + "-native"
