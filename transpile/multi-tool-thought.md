# Multi-tool response metadata

Disposition: **PORT** — repair behavior at the existing shared upstream pin; no pin advance or new deviation.

The pinned Python `openhands-sdk/openhands/sdk/agent/response_dispatch.py` gives only the first action in a tool-call batch the response's thought, reasoning content, thinking blocks and Responses reasoning item. `tests/sdk/agent/test_response_dispatch.py::test_batch_action_events_are_emitted_consecutively` asserts the first-action thought rule and shared response identity.

The TypeScript action constructor previously copied these fields to every action. Its own EventLog-to-message conversion rejected the next step with `Expected empty thought for multi-action events after the first one`. This was reproduced by the real WhatsApp canary after two media tools had both completed.

The adapted dispatch test checks the upstream invariant and message reconstruction. The constructor test covers all reasoning metadata. A real Agent regression executes two tools, restores a ConversationState from their events, and reaches a second model completion without repeating either effect. All three regressions failed before the correction.

This change fixes newly produced batches. It does not silently rewrite existing malformed EventLogs; operators must retain and explicitly reconcile those histories, or use a fresh isolated conversation after accounting for completed effects. SmolPaws tracking: `smolpaws-956`.
