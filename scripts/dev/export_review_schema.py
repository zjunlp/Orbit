"""Print source schemas; generation has no runtime state or credential side effects."""

import json

from pydantic import TypeAdapter

from agent_infra.runs.review_api import ExperimentReview, SessionList


def remove_field_titles(node: object) -> None:
    """Keep model names; field titles otherwise create hundreds of scalar aliases."""
    if isinstance(node, dict):
        for field in node.get("properties", {}).values():
            field.pop("title", None)
        for value in node.values():
            remove_field_titles(value)
    elif isinstance(node, list):
        for value in node:
            remove_field_titles(value)


if __name__ == "__main__":
    schema = TypeAdapter(ExperimentReview | SessionList).json_schema(mode="serialization")
    remove_field_titles(schema)
    print(json.dumps(schema, indent=2, ensure_ascii=False))
