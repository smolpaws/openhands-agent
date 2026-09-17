#!/usr/bin/env python3
"""Generate focused condensation wire/replay evidence from the manifest-pinned SDK.

Use the pinned packages on PYTHONPATH and their installed dependencies. Persisted
records come from the real Python EventLog, including its exclude_none behavior.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import subprocess
from pathlib import Path

from openhands.sdk.context.view import View
from openhands.sdk.conversation.event_store import EventLog
from openhands.sdk.event import (
    ActionEvent,
    AgentErrorEvent,
    Condensation,
    CondensationRequest,
    CondensationSummaryEvent,
    Event,
    MessageEvent,
)
from openhands.sdk.io import InMemoryFileStore
from openhands.sdk.llm import Message, MessageToolCall, TextContent


TIMESTAMP = "2026-01-01T00:00:00Z"


def event_id(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


def base(number: int) -> dict:
    return {"id": event_id(number), "timestamp": TIMESTAMP}


def message(number: int) -> MessageEvent:
    return MessageEvent(
        **base(number),
        source="user",
        llm_message=Message(role="user", content=[TextContent(text=f"Work {number}")]),
    )


def condensation(number: int, forgotten: list[str], **kwargs) -> Condensation:
    return Condensation(
        **base(number),
        forgotten_event_ids=set(forgotten),
        llm_response_id=f"response-{number}",
        **kwargs,
    )


def scenarios() -> list[tuple[str, list[Event]]]:
    history = [message(number) for number in range(1, 5)]
    first = condensation(
        6,
        [event_id(1), event_id(2), event_id(1)],
        summary="Earlier work",
        summary_offset=1,
    )
    call = MessageToolCall(
        id="invalid-call", name="terminal", arguments="{invalid", origin="completion"
    )
    null_action = ActionEvent(
        **base(10),
        action=None,
        tool_name="terminal",
        tool_call_id=call.id,
        tool_call=call,
        llm_response_id="response-invalid",
        thought=[],
    )
    error = AgentErrorEvent(
        **base(11),
        tool_name="terminal",
        tool_call_id=call.id,
        error="Invalid arguments",
    )
    return [
        ("pending-request", [*history, CondensationRequest(**base(5))]),
        (
            "set-deduplication-and-middle-offset",
            [
                *history,
                CondensationRequest(**base(5)),
                first,
            ],
        ),
        (
            "empty-summary-at-zero",
            [
                *history,
                condensation(
                    6,
                    [event_id(1)],
                    summary="",
                    summary_offset=0,
                ),
            ],
        ),
        (
            "missing-summary-removes-without-inserting",
            [
                *history,
                condensation(
                    6,
                    [event_id(1)],
                    summary=None,
                    summary_offset=0,
                ),
            ],
        ),
        (
            "missing-offset-removes-without-inserting",
            [
                *history,
                condensation(
                    6,
                    [event_id(1)],
                    summary="No insertion offset",
                    summary_offset=None,
                ),
            ],
        ),
        (
            "offset-past-tail-appends",
            [
                *history,
                condensation(
                    6,
                    [event_id(1)],
                    summary="Append summary",
                    summary_offset=99,
                ),
            ],
        ),
        (
            "multiple-summaries-and-later-request",
            [
                *history,
                first,
                CondensationRequest(**base(7)),
                condensation(
                    8,
                    [f"{first.id}-summary", event_id(3)],
                    summary="Combined progress",
                    summary_offset=0,
                ),
                CondensationRequest(**base(9)),
            ],
        ),
        (
            "materialized-summary",
            [
                CondensationSummaryEvent(
                    **base(12),
                    summary="Imported summary",
                    source="environment",
                ),
                message(4),
            ],
        ),
        ("null-action-and-matching-error", [message(1), null_action, error]),
    ]


def canonical(value, key: str = ""):
    if isinstance(value, dict):
        return {name: canonical(item, name) for name, item in value.items()}
    if isinstance(value, list):
        items = [canonical(item) for item in value]
        return sorted(items) if key == "forgotten_event_ids" else items
    return value


def view_snapshot(events: list[Event]) -> dict:
    view = View.from_events(events)
    rendered = [
        event.model_dump(mode="json", exclude_none=True) for event in view.events
    ]
    # View-generated summaries intentionally get a fresh timestamp on each replay.
    for event in rendered:
        event.pop("timestamp")
    return canonical(
        {
            "events": rendered,
            "unhandled_condensation_request": view.unhandled_condensation_request,
            "manipulation_indices": sorted(view.manipulation_indices),
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
    checkout = args.upstream.resolve()
    head = subprocess.check_output(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    if head != pin:
        raise ValueError("Checkout does not match manifest pin")
    sources = {}
    for cls in (
        EventLog,
        Event,
        View,
        Condensation,
        CondensationRequest,
        CondensationSummaryEvent,
        ActionEvent,
        AgentErrorEvent,
    ):
        source = Path(inspect.getfile(cls)).resolve()
        if not source.is_relative_to(checkout):
            raise ValueError(f"Imported {cls.__name__} is not from pinned checkout")
        sources[str(source.relative_to(checkout))] = hashlib.sha256(
            source.read_bytes(),
        ).hexdigest()
    cases = []
    for name, events in scenarios():
        store = InMemoryFileStore()
        log = EventLog(store)
        for event in events:
            log.append(event)
        files = [
            {"path": path, "event": json.loads(store.read(path))}
            for path in sorted(store.list("events"))
            if path.endswith(".json")
        ]
        restored = list(EventLog(store))
        cases.append(
            canonical(
                {
                    "name": name,
                    "events": [
                        event.model_dump(mode="json", exclude_none=False)
                        for event in events
                    ],
                    "files": files,
                    "restored": [
                        event.model_dump(mode="json", exclude_none=True)
                        for event in restored
                    ],
                    "null_action_ids": [
                        event.id
                        for event in restored
                        if isinstance(event, ActionEvent) and event.action is None
                    ],
                    "view": view_snapshot(restored),
                }
            )
        )
    output = {
        "upstream_commit": pin,
        "source_sha256": dict(sorted(sources.items())),
        "cases": cases,
    }
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
    print(f"Generated {len(cases)} pinned Python EventLog wire/replay cases")


if __name__ == "__main__":
    main()
