"""Stable task identities shared by catalog discovery, Solve and Verify."""

import json
from urllib.parse import quote, unquote


# The runner and exporter supply these fields independently of the task descriptor.
RESERVED_FIELDS = {
    "name", "suite", "episode_idx", "task_idx", "episode_id", "shard_id", "num_shards",
    "sid", "eid", "steps", "elapsed_sec", "metrics", "failure_reason", "failure_detail",
}


def identity_fields(config, default=()):
    raw = config.get("taskIdentityFields")
    if raw is None:
        return default
    fields = json.loads(raw)
    if (not isinstance(fields, list) or not fields
            or any(not isinstance(field, str) or not field or field in RESERVED_FIELDS for field in fields)
            or len(set(fields)) != len(fields)):
        raise ValueError("taskIdentityFields must be a JSON array of distinct stable task fields")
    return tuple(sorted(fields))


def valid_value(value):
    return type(value) is int or isinstance(value, str) and bool(value)


def task_suite(task):
    suite = task.get("suite")
    return "task" if suite is None or suite == "" else suite


def catalog_identity(row, fields):
    suite, name = task_suite(row), row["name"]
    if not isinstance(suite, str) or not isinstance(name, str) or not name:
        raise ValueError("task identity requires a suite and a nonempty task name")
    identity = {"suite": suite, "name": name}
    for field in fields:
        value = row.get("identity", {}).get(field)
        if not valid_value(value):
            raise ValueError(f"task {suite}:{name} lacks a stable value for identity field {field!r}")
        identity[field] = value
    return identity


def task_id(identity, fields):
    parts = [
        quote(field, safe="") + "=" + quote(json.dumps(identity[field], ensure_ascii=False), safe="")
        for field in fields
    ]
    return f"{quote(identity['suite'], safe='')}:@{','.join(parts)}:{identity['name']}"


def parse_task_id(identifier, fields):
    if not fields:
        return None
    suite, _, suffix = identifier.partition(":")
    encoded, separator, name = suffix.partition(":")
    if not separator or not encoded.startswith("@") or "=" not in encoded:
        return None
    try:
        pairs = [part.split("=", 1) for part in encoded[1:].split(",")]
        parsed = {unquote(key): json.loads(unquote(value)) for key, value in pairs}
    except ValueError as exc:
        raise ValueError("invalid task identity; select a task from the current catalog") from exc
    if (not suite or not name or tuple(sorted(parsed)) != fields
            or not all(map(valid_value, parsed.values()))):
        raise ValueError("invalid task identity; select a task from the current catalog")
    identity = {"suite": unquote(suite), "name": name, **parsed}
    if task_id(identity, fields) != identifier:
        raise ValueError("invalid task identity; select a task from the current catalog")
    return identity


def matches_task(task, identity):
    for field, expected in identity.items():
        actual = task_suite(task) if field == "suite" else task.get(field)
        if type(actual) is not type(expected) or actual != expected:
            return False
    return True
