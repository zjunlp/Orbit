"""Container-side embodied evaluation; no model or simulator imports at package import."""

from .binding import digest, resolve_binding

__all__ = ["EpisodeFailure", "StepResult", "digest", "resolve_binding", "run_episode", "verify_episode"]


def __getattr__(name):
    if name in ("EpisodeFailure", "StepResult", "run_episode"):
        from . import driver
        return getattr(driver, name)
    if name == "verify_episode":
        from .evidence import verify_episode
        return verify_episode
    raise AttributeError(name)
