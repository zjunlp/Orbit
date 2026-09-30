"""A plain Docker command on a frozen workspace, without an Agent or Task dependency."""

from pathlib import Path
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent_infra.environments.execution_api import ExecutionSpec


class ReadonlyMount(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    source: str
    target: str

    @model_validator(mode="after")
    def valid(self) -> Self:
        if not Path(self.source).is_absolute():
            raise ValueError("mount source must be absolute")
        target = Path(self.target)
        if not target.is_relative_to("/inputs") or ".." in target.parts or str(target) == "/inputs":
            raise ValueError("data mounts must be beneath /inputs")
        return self


class CommandExecutionSpec(ExecutionSpec):
    image: str = Field(min_length=1)
    snapshot: str
    snapshot_digest: str
    cpu_cores: float = Field(gt=0)
    memory_bytes: int = Field(ge=6 * 1024**2)
    gpu_device_ids: tuple[str, ...] = ()
    mounts: tuple[ReadonlyMount, ...] = ()
    network: bool = False

    @model_validator(mode="after")
    def command_valid(self) -> Self:
        if not Path(self.snapshot).is_absolute() or not self.image.startswith("sha256:"):
            raise ValueError("command requires an absolute snapshot and resolved image digest")
        if len(set(self.gpu_device_ids)) != len(self.gpu_device_ids):
            raise ValueError("GPU UUIDs must be unique")
        if any(not device.startswith("GPU-") for device in self.gpu_device_ids):
            raise ValueError("use GPU UUIDs, not numeric indices")
        return self
