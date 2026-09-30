"""User-facing direct experiment contract; a research plan is optional."""

from pathlib import Path
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent_infra.contracts.files import relative_path
from agent_infra.environments.command_api import ReadonlyMount


class CommandRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        allow_inf_nan=False,
        json_schema_serialization_defaults_required=True,
    )
    project: str
    project_id: str | None = None
    name: str = Field(default="Experiment", min_length=1, max_length=200)
    image: str = Field(min_length=1, max_length=1024)
    argv: tuple[str, ...]
    cwd: str = "."
    cpu_cores: float = Field(default=1, gt=0)
    memory_bytes: int = Field(default=2 * 1024**3, ge=6 * 1024**2)
    gpu_device_ids: tuple[str, ...] = ()
    mounts: tuple[ReadonlyMount, ...] = ()
    outputs: tuple[str, ...] = ("outputs",)
    timeout_seconds: float = Field(default=3600, gt=0, le=604600)
    network: bool = False
    session_id: str | None = None
    provider: str | None = None
    parent_run_id: str | None = None

    @model_validator(mode="after")
    def valid(self) -> Self:
        if not Path(self.project).is_absolute():
            raise ValueError("project directory must be absolute")
        if not 1 <= len(self.argv) <= 128 or not self.argv[0] or any("\0" in a for a in self.argv):
            raise ValueError("argv requires an executable and at most 128 arguments")
        if sum(map(len, self.argv)) > 65536:
            raise ValueError("argv exceeds 64 KiB")
        if self.cwd != ".":
            relative_path(self.cwd)
        for output in self.outputs:
            relative_path(output)
            if output.startswith(".infra-evidence"):
                raise ValueError(".infra-evidence is reserved for execution provenance")
        if not self.outputs or len(set(self.outputs)) != len(self.outputs):
            raise ValueError("outputs must contain unique relative paths")
        if len(set(self.gpu_device_ids)) != len(self.gpu_device_ids) or any(
            not value.startswith("GPU-") for value in self.gpu_device_ids
        ):
            raise ValueError("GPU devices must be unique UUIDs")
        return self
