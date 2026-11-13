"""Prepare deterministic evaluation with the pinned VLABench source copy."""

from pathlib import Path
import sys


def replace(root, relative, original, fixed, count):
    path = root / relative
    content = path.read_text()
    if content.count(original) != count:
        raise ValueError("the pinned VLABench source has changed: " + relative)
    path.write_text(content.replace(original, fixed))


def main(root):
    loader = "envs/__init__.py"
    replace(root, loader, "             **kwargs):",
            "             random_state=None,\n             **kwargs):", 1)
    replace(root, loader, "reset_wait_step=reset_wait_step)",
            "reset_wait_step=reset_wait_step,\n                        random_state=random_state)", 1)

    # A trailing comma turns the XYZ vector into a tuple containing a vector.
    position = '["position"] = [(i-0.5)*0.7, random.uniform(-0.1, 0.1), 0.8]'
    cluster = "tasks/hierarchical_tasks/composite/cluster_series.py"
    replace(root, cluster, position + ",", position, 2)
    # These configs place the receptacles outside the object grid. Keep the
    # grid sampler from moving the large trays and gift boxes onto the objects.
    for name in ("ClusterToyTask", "ClusterIngredientsTask"):
        init = (f"class {name}(ClusterTask):\n"
                "    def __init__(self, task_name, robot, **kwargs):\n"
                "        super().__init__(task_name, robot, **kwargs)")
        keep_positions = """
        receptacles = [f"{container}_{index}" for index, container in enumerate(self.target_container)]
        self.random_ignored_entities = [*self.random_ignored_entities, *receptacles]"""
        replace(root, cluster, init, init + keep_positions, 1)
    # Respect the explicitly sized cylinder and capsule in the weight experiment.
    # Keep the upstream random defaults for unspecified shapes.
    replace(root, "tasks/components/specific_entities/random_geom.py",
            'if geom_type is None or geom_type not in geom_types:',
            'if geom_type not in (*geom_types, "cylinder", "capsule"):', 1)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
