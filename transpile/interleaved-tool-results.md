# Concurrent user messages and completed tool results

Classification: **PORT / provider compatibility**, at the unchanged pin in `upstream.json`.

The September 15 SmolPaws failure persisted a valid chronological sequence: tool action,
concurrent user message, completed tool observation. Sending that chronology directly to
DeepSeek Chat Completions returned HTTP 400 because the user message split the call/result
exchange. The tool had completed; its result was not missing.

At the pinned Python source, `conversation/impl/local_conversation.py::send_message` acquires
conversation state, and the run loop holds that state lock across tool execution. Its
`_released_state_lock_during_io` releases the lock for LLM I/O specifically. The TypeScript
async host can durably append a user event during a tool await. Python's
`event/base.py::events_to_messages` itself does not reorder messages, so changing that exported
conversion's semantics would not be a direct port of its implementation.

The provider adapters therefore share `llm/tool-result-order.ts`, a pure request preparation
helper under the existing provider compatibility policy. When all results of an assistant
batch are present, it moves only intervening plain user messages after those results. User
messages retain their relative order and content; tool results retain their relative order;
reasoning metadata stays on the assistant call. It does not modify, remove or re-execute
persisted events, synthesize missing results, or cross a subsequent assistant/system turn.
Incomplete or invalid batches remain invalid for normal validation rather than being hidden.
OpenAI Chat/Responses (including subscription), Anthropic and Gemini invoke the helper before
their native request serialization. Provider-specific wire formats remain in their adapters.

Evidence: `src/llm/__tests__/tool-result-order.test.ts` contains a sanitized reproduction of the
actual request shape. The four native serializer cases failed before the helper; regression
coverage includes parallel results, multiple concurrent messages, immutable input, idempotent
projection, missing results, unrelated results and assistant boundaries. Live DeepSeek tests
are viability evidence, not a claim that a Python differential test was executed.

This is a provider compatibility correction, not an upstream pin advance or new runtime queue.
