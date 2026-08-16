#!/usr/bin/env python3

from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter


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


def build_tool_definition(tool_type: Any, case: dict[str, Any]) -> Any:
    fields = model_field_names(tool_type)
    values: dict[str, Any] = {}

    for key in ("name", "description"):
        if key in fields:
            values[key] = case[key]

    for candidate in ("parameters", "input_schema", "args_schema", "schema"):
        if candidate in fields:
            values[candidate] = case["parameters"]
            break
    else:
        raise RuntimeError(
            "Pinned ToolDefinition has no recognized parameter-schema field: "
            + ", ".join(sorted(fields))
        )

    if "type" in fields:
        values["type"] = "function"

    return tool_type.model_validate(values)


def main() -> None:
    args = parse_args()
    document = json.loads(Path(args.cases).read_text())
    if document.get("schemaVersion") != 1 or not isinstance(document.get("cases"), list):
        raise RuntimeError("Unsupported tool-case document")

    tool_type = resolve_export(
        "ToolDefinition",
        [
            "openhands.sdk.tool",
            "openhands.sdk.tool.schema",
            "openhands.sdk.tool.spec",
            "openhands.sdk.tool.tool",
        ],
    )
    adapter: TypeAdapter[Any] = TypeAdapter(tool_type)
    results: dict[str, Any] = {}

    for raw_case in document["cases"]:
        if not isinstance(raw_case, dict):
            raise RuntimeError("Every tool case must be an object")
        case_id = raw_case.get("id")
        if not isinstance(case_id, str) or not case_id:
            raise RuntimeError("Every tool case needs a non-empty id")
        if case_id in results:
            raise RuntimeError(f"Duplicate tool case id: {case_id}")
        if raw_case.get("kind") != "tool-definition":
            raise RuntimeError(f"Unsupported tool case kind: {raw_case.get('kind')}")

        tool = build_tool_definition(tool_type, raw_case)
        dumped = adapter.dump_python(
            tool,
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
    print(f"Wrote {output_path} ({len(results)} tool-definition cases)")


if __name__ == "__main__":
    main()
