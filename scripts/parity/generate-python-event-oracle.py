#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter


FIXED_EVENT_ID = "00000000-0000-0000-0000-000000000001"
FIXED_TIMESTAMP = datetime(2026, 1, 1, tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def resolve_export(name: str, modules: list[str]) -> Any:
    for module_name in modules:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        value = getattr(module, name, None)
        if value is not None:
            return value
    joined = ", ".join(modules)
    raise RuntimeError(f"Could not resolve {name} from pinned SDK modules: {joined}")


def canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonicalize(entry) for entry in value]
    return value


def model_field_names(model_type: Any) -> set[str]:
    fields = getattr(model_type, "model_fields", None)
    if not isinstance(fields, dict):
        raise RuntimeError(f"{model_type!r} does not expose pydantic model_fields")
    return set(fields)


def build_message_event(
    message_event_type: Any,
    message_adapter: TypeAdapter[Any],
    case: dict[str, Any],
) -> Any:
    field_names = model_field_names(message_event_type)
    values: dict[str, Any] = {}

    if "source" in field_names:
        values["source"] = case["source"]
    if "id" in field_names:
        values["id"] = FIXED_EVENT_ID
    if "event_id" in field_names:
        values["event_id"] = FIXED_EVENT_ID
    if "timestamp" in field_names:
        values["timestamp"] = FIXED_TIMESTAMP
    if "created_at" in field_names:
        values["created_at"] = FIXED_TIMESTAMP

    message = message_adapter.validate_python(case["message"])
    for candidate in ("llm_message", "message"):
        if candidate in field_names:
            values[candidate] = message
            break
    else:
        raise RuntimeError(
            "Pinned MessageEvent has neither an llm_message nor message field: "
            + ", ".join(sorted(field_names))
        )

    return message_event_type.model_validate(values)


def main() -> None:
    args = parse_args()
    document = json.loads(Path(args.cases).read_text())
    if document.get("schemaVersion") != 1 or not isinstance(document.get("cases"), list):
        raise RuntimeError("Unsupported event-case document")

    message_type = resolve_export(
        "Message",
        [
            "openhands.sdk.llm",
            "openhands.sdk.llm.message",
            "openhands.sdk.llm.types",
        ],
    )
    message_event_type = resolve_export(
        "MessageEvent",
        [
            "openhands.sdk.event",
            "openhands.sdk.event.llm_convertible",
            "openhands.sdk.event.llm_convertible.message",
            "openhands.sdk.event.message",
        ],
    )
    message_adapter: TypeAdapter[Any] = TypeAdapter(message_type)
    event_adapter: TypeAdapter[Any] = TypeAdapter(message_event_type)
    results: dict[str, Any] = {}

    for raw_case in document["cases"]:
        if not isinstance(raw_case, dict):
            raise RuntimeError("Every event case must be an object")
        case_id = raw_case.get("id")
        if not isinstance(case_id, str) or not case_id:
            raise RuntimeError("Every event case needs a non-empty id")
        if case_id in results:
            raise RuntimeError(f"Duplicate event case id: {case_id}")
        if raw_case.get("kind") != "message-event":
            raise RuntimeError(f"Unsupported event case kind: {raw_case.get('kind')}")
        if raw_case.get("source") not in {"user", "agent", "environment"}:
            raise RuntimeError(f"Unsupported event source: {raw_case.get('source')}")

        event = build_message_event(message_event_type, message_adapter, raw_case)
        dumped = event_adapter.dump_python(
            event,
            mode="json",
            by_alias=True,
            exclude_none=False,
            exclude_unset=False,
            exclude_defaults=False,
        )
        results[case_id] = canonicalize(dumped)

    commit = os.environ.get("OPENHANDS_UPSTREAM_COMMIT", "")
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise RuntimeError("OPENHANDS_UPSTREAM_COMMIT must be a full lowercase SHA")

    output = {
        "schemaVersion": 1,
        "source": {
            "repository": "OpenHands/software-agent-sdk",
            "commit": commit,
        },
        "results": results,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {output_path} ({len(results)} event cases)")


if __name__ == "__main__":
    main()
