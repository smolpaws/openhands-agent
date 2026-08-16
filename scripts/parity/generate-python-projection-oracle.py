#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib
import inspect
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from pydantic import TypeAdapter


BASE_TIMESTAMP = datetime(2026, 1, 1, tzinfo=timezone.utc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def import_modules(names: list[str]) -> list[Any]:
    modules: list[Any] = []
    for name in names:
        try:
            modules.append(importlib.import_module(name))
        except ImportError:
            continue
    return modules


def resolve_export(name: str, modules: list[Any]) -> Any:
    for module in modules:
        value = getattr(module, name, None)
        if value is not None:
            return value
    names = ", ".join(module.__name__ for module in modules)
    raise RuntimeError(f"Could not resolve {name} from pinned SDK modules: {names}")


def resolve_projection(modules: list[Any]) -> Callable[..., Any]:
    preferred = [
        "events_to_messages",
        "events_to_llm_messages",
        "convert_events_to_messages",
    ]
    for name in preferred:
        for module in modules:
            value = getattr(module, name, None)
            if callable(value):
                return value

    # Upstream exposes the projection as a static method on LLMConvertibleEvent
    # rather than as a module-level function.
    for module in modules:
        owner = getattr(module, "LLMConvertibleEvent", None)
        if owner is None:
            continue
        for name in preferred:
            value = getattr(owner, name, None)
            if callable(value):
                return value

    discovered: list[Callable[..., Any]] = []
    for module in modules:
        for name in dir(module):
            normalized = name.lower()
            value = getattr(module, name)
            if (
                callable(value)
                and "event" in normalized
                and "message" in normalized
                and not inspect.isclass(value)
            ):
                discovered.append(value)
    unique = list(dict.fromkeys(discovered))
    if len(unique) == 1:
        return unique[0]

    candidates = ", ".join(
        f"{value.__module__}.{getattr(value, '__name__', '<callable>')}"
        for value in unique
    )
    raise RuntimeError(
        "Could not resolve a unique events-to-messages function. Candidates: " + candidates
    )


def canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonicalize(entry) for entry in value]
    return value


def model_fields(model_type: Any) -> dict[str, Any]:
    fields = getattr(model_type, "model_fields", None)
    if not isinstance(fields, dict):
        raise RuntimeError(f"{model_type!r} does not expose pydantic model_fields")
    return fields


def assign_value(
    values: dict[str, Any],
    model_type: Any,
    field_name: str,
    candidates: list[Any],
) -> None:
    field = model_fields(model_type).get(field_name)
    if field is None:
        return
    adapter: TypeAdapter[Any] = TypeAdapter(field.annotation)
    for candidate in candidates:
        try:
            values[field_name] = adapter.validate_python(candidate)
            return
        except Exception:
            continue
    raise RuntimeError(
        f"Could not validate a deterministic value for {model_type.__name__}.{field_name}"
    )


def build_event(
    message_event_type: Any,
    message_adapter: TypeAdapter[Any],
    recipe: dict[str, Any],
    index: int,
) -> Any:
    fields = set(model_fields(message_event_type))
    values: dict[str, Any] = {}
    if "source" in fields:
        values["source"] = recipe["source"]

    event_id = f"00000000-0000-0000-0000-{index + 1:012d}"
    timestamp = BASE_TIMESTAMP + timedelta(seconds=index)
    assign_value(values, message_event_type, "id", [event_id, str(index + 1), index + 1])
    assign_value(
        values,
        message_event_type,
        "event_id",
        [event_id, str(index + 1), index + 1],
    )
    assign_value(
        values,
        message_event_type,
        "timestamp",
        [timestamp, timestamp.isoformat().replace("+00:00", "Z")],
    )
    assign_value(
        values,
        message_event_type,
        "created_at",
        [timestamp, timestamp.isoformat().replace("+00:00", "Z")],
    )

    message = message_adapter.validate_python(recipe["message"])
    for candidate in ("llm_message", "message"):
        if candidate in fields:
            values[candidate] = message
            break
    else:
        raise RuntimeError(
            "Pinned MessageEvent has neither an llm_message nor message field: "
            + ", ".join(sorted(fields))
        )
    return message_event_type.model_validate(values)


def invoke_projection(function: Callable[..., Any], events: list[Any]) -> Any:
    attempts = [
        lambda: function(events),
        lambda: function(events=events),
    ]
    errors: list[str] = []
    for attempt in attempts:
        try:
            result = attempt()
            if inspect.isawaitable(result):
                raise RuntimeError("events-to-messages projection unexpectedly returned awaitable")
            return result
        except TypeError as error:
            errors.append(str(error))
    raise RuntimeError("Could not invoke events-to-messages projection: " + " | ".join(errors))


def main() -> None:
    args = parse_args()
    document = json.loads(Path(args.cases).read_text())
    if document.get("schemaVersion") != 1 or not isinstance(document.get("cases"), list):
        raise RuntimeError("Unsupported projection-case document")

    modules = import_modules(
        [
            "openhands.sdk.event",
            "openhands.sdk.event.llm_convertible",
            "openhands.sdk.event.llm_convertible.message",
            "openhands.sdk.llm",
            "openhands.sdk.conversation",
        ]
    )
    message_type = resolve_export("Message", modules)
    message_event_type = resolve_export("MessageEvent", modules)
    projection = resolve_projection(modules)
    message_adapter: TypeAdapter[Any] = TypeAdapter(message_type)
    messages_adapter: TypeAdapter[Any] = TypeAdapter(list[message_type])
    events_adapter: TypeAdapter[Any] = TypeAdapter(list[message_event_type])
    inputs: dict[str, Any] = {}
    results: dict[str, Any] = {}

    for raw_case in document["cases"]:
        if not isinstance(raw_case, dict):
            raise RuntimeError("Every projection case must be an object")
        case_id = raw_case.get("id")
        recipes = raw_case.get("events")
        if not isinstance(case_id, str) or not case_id:
            raise RuntimeError("Every projection case needs a non-empty id")
        if case_id in results:
            raise RuntimeError(f"Duplicate projection case id: {case_id}")
        if raw_case.get("kind") != "events-to-messages" or not isinstance(recipes, list):
            raise RuntimeError(f"Unsupported projection case: {raw_case}")

        events = [
            build_event(message_event_type, message_adapter, recipe, index)
            for index, recipe in enumerate(recipes)
        ]
        inputs[case_id] = canonicalize(
            events_adapter.dump_python(
                events,
                mode="json",
                by_alias=True,
                exclude_none=False,
                exclude_unset=False,
                exclude_defaults=False,
            )
        )
        messages = invoke_projection(projection, events)
        dumped = messages_adapter.dump_python(
            messages,
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
        "projection": {
            "module": projection.__module__,
            "name": getattr(projection, "__name__", type(projection).__name__),
        },
        "inputs": inputs,
        "results": results,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {output_path} ({len(results)} projection cases)")


if __name__ == "__main__":
    main()
