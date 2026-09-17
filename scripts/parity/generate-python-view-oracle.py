#!/usr/bin/env python3
"""Generate deterministic View expectations using the manifest-pinned Python SDK.

Run with the pinned checkout's packages on PYTHONPATH and its dependencies installed.
The source revision and imported implementation path are verified before evaluation.
"""
from __future__ import annotations

import argparse
import inspect
import json
import logging
import subprocess
from pathlib import Path

from openhands.sdk.context.view import View
from openhands.sdk.event import (
    ActionEvent,
    AgentErrorEvent,
    Condensation,
    CondensationRequest,
    CondensationSummaryEvent,
    ConversationStateUpdateEvent,
    MessageEvent,
    ObservationEvent,
    UserRejectObservation,
)
from openhands.sdk.llm import Message, MessageToolCall, TextContent, ThinkingBlock
from openhands.sdk.mcp.definition import MCPToolAction, MCPToolObservation


def build_event(recipe):
    base = {"id": recipe["id"], "timestamp": "2026-01-01T00:00:00Z"}
    kind = recipe["kind"]
    if kind == "message":
        return MessageEvent(**base, source="user", llm_message=Message(
            role="user", content=[TextContent(text=recipe["id"])],
        ))
    if kind == "action":
        call = recipe["call"]
        return ActionEvent(
            **base, action=MCPToolAction(data={}), tool_name="test_tool",
            tool_call_id=call, llm_response_id=recipe["batch"], thought=[],
            tool_call=MessageToolCall(id=call, name="test_tool", arguments="{}", origin="completion"),
            thinking_blocks=[ThinkingBlock(thinking="Test thinking", signature="sig")] if recipe.get("thinking") else [],
        )
    if kind in ("observation", "error", "reject"):
        values = {**base, "tool_name": "test_tool", "tool_call_id": recipe["call"]}
        if kind == "error":
            return AgentErrorEvent(**values, error="Interrupted")
        if kind == "reject":
            return UserRejectObservation(**values, action_id=recipe["call"])
        return ObservationEvent(
            **values, action_id=recipe["call"],
            observation=MCPToolObservation.from_text(text="Success", tool_name="test_tool"),
        )
    if kind == "condensation":
        return Condensation(
            **base, forgotten_event_ids=set(recipe["forget"]),
            summary=recipe.get("summary"), summary_offset=recipe.get("offset"),
            llm_response_id=recipe["id"] + "-response",
        )
    if kind == "request":
        return CondensationRequest(**base)
    if kind == "state":
        return ConversationStateUpdateEvent(**base, key="test", value={})
    raise ValueError(f"Unknown event recipe kind: {kind}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((root / "transpile/upstream.json").read_text())
    pin = manifest["commit"]
    checkout = args.upstream.resolve()
    head = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    if head != pin:
        raise ValueError(f"Upstream checkout {head} does not match manifest pin {pin}")
    if not Path(inspect.getfile(View)).resolve().is_relative_to(checkout):
        raise ValueError("Imported View is not from the specified pinned checkout")
    logging.getLogger("openhands.sdk.context.view.view").setLevel(logging.ERROR)
    output = []
    for case in json.loads(args.cases.read_text()):
        events = [build_event(recipe) for recipe in case["events"]]
        view = View.from_events(events)
        output.append({
            "name": case["name"],
            "event_ids": [event.id for event in view.events],
            "summaries": [{"id": event.id, "summary": event.summary} for event in view.events if isinstance(event, CondensationSummaryEvent)],
            "manipulation_indices": sorted(view.manipulation_indices),
            "unhandled_condensation_request": view.unhandled_condensation_request,
        })
    args.output.write_text(json.dumps({"upstream_commit": pin, "cases": output}, indent=2) + "\n")
    print(f"Generated {len(output)} pinned Python View cases")


if __name__ == "__main__":
    main()
