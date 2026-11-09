"""Apply the ImageMagick compatibility fix to the pinned simulator image copy."""

from pathlib import Path
import sys


def main(root):
    package = root / "libero"
    source = package / "libero/envs/env_wrapper.py"
    original = """    x = cv2.imdecode(np.fromstring(x.make_blob(), np.uint8),
                    cv2.IMREAD_UNCHANGED)

    if x.shape != (224, 224):
        return np.clip(x[..., [2, 1, 0]], 0, 255)  # BGR to RGB
    else:  # greyscale to RGB
        return np.clip(np.array([x, x, x]).transpose((1, 2, 0)), 0, 255)
"""
    fixed = """    blob = x.make_blob(format="PNG")
    image = cv2.imdecode(np.frombuffer(blob, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("ImageMagick motion blur produced an invalid PNG")
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
"""
    content = source.read_text()
    if content.count(original) != 1:
        raise ValueError("the pinned LIBERO-Plus motion blur source has changed")
    source.write_text(content.replace(original, fixed))
    (package / "__init__.py").touch()


if __name__ == "__main__":
    main(Path(sys.argv[1]))
