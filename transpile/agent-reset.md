# Agent-controlled context reset evidence

Date: 2026-09-20. SDK implementation and independent integration review are complete; PR review and merge remain the next gate.
This is the opt-in SmolPaws `smolpaws-te15` work, not a Python pin advance or a
production rollout. The source authority remains the canonical commit in
[upstream.json](upstream.json). Existing interval reviews and the completed
[standard condensation evidence](condensation.md) retain their historical scope.

## Classification and source boundaries

[EXT-SDK-004](../docs/TRANSPILE_CONTRACT.md#ext-sdk-004--agent-requested-context-reset-tool-and-settings)
covers the new tool and settings.
[DEV-SDK-012](../docs/TRANSPILE_CONTRACT.md#dev-sdk-012--opt-in-agent-controlled-context-reset)
covers the opt-in Agent, View, event and LocalConversation behavior. A new tool
alone would not justify changing those parity-governed surfaces.

Python paths below are relative to `openhands-sdk/openhands/sdk/` at the canonical
pin. Source inspection, rather than a Python-equivalence claim, bounds this mode:

| Source | Existing behavior | Selected target behavior |
| --- | --- | --- |
| `tool/builtins/__init__.py` | Registered built-ins do not include an agent-callable condense tool. | Opt-in `CondenseTool`; existing event wrappers with typed action/observation payloads. |
| `agent/agent.py` | Context-window and malformed-history errors can request ordinary condensation. | Only actual typed context-window overflow activates the separately configured emergency fallback in agent-reset mode. |
| `context/condenser/base.py::RollingCondenser.condense` | HARD first tries `get_condensation`; `NoCondensationAvailableException` permits hard reset. | Direct invocation of the existing full-view reset method after the caught error; no ordinary cut first and no pipeline. |
| `context/condenser/llm_summarizing_condenser.py::hard_context_reset` | Summarizes all supplied View events at offset zero, with bounded progressively clipped event representations. | Reuse this algorithm for eligible old history, protecting unconsumed input outside that View. |
| `context/view/`, `event/condenser.py` | Replays forgotten IDs and optional generated summary. | Add versioned optional reset provenance and a validated no-summary tool-exchange seed or emergency notice/summary seed. |
| `conversation/impl/local_conversation.py::condense` | Host requests condensation supported by the configured condenser. | Typed unsupported error for agent-reset mode; standard summarizer maintenance unchanged. |
| `settings/model.py` | Ordinary condenser configuration. | Strict reset settings and optional independent hard fallback; existing settings defaults remain unchanged. |

The same Python hard-reset routing and method were also inspected at source
revision `becbde606074dc1a4f9bccc0e819170f865d13b0` on this date. That later
inspection does not advance the manifest pin. Ordinary summary failure may raise
`NoCondensationAvailableException` even with a valid cut, so Python's HARD fallback
is not limited to “no valid cut.” Full-view summaries still use event previews;
neither the original algorithm nor this extension promises lossless full-text
transfer.

## Observable configuration

```json
{
  "llm_profile_ref": "main",
  "condenser": {
    "condenser_kind": "agent_reset",
    "warning_thresholds": [0.75, 0.80, 0.85, 0.90]
  },
  "hard_condenser": {
    "condenser_kind": "llm_summarizing",
    "llm_profile_ref": "summary",
    "hard_context_reset_max_retries": 5,
    "hard_context_reset_context_scaling": 0.8
  }
}
```

The names above are the implemented SDK settings, not a claim that a running
server already accepts them. Warning fractions must be finite, strictly ascending,
unique and greater than zero through one. Enabled reset needs no auxiliary profile.
A nonnull hard fallback requires enabled reset, the explicit summarizer kind and
its own profile reference; a host default cannot fill a missing reference.
Omitted/null hard fallback makes no lookup and no paid call. Omission remains absent
through JSON round trips; agent-settings version remains unchanged.

Hard fallback accepts only profile and retry/scaling fields. It rejects ordinary
`max_tokens`, `max_size`, `keep_first`, `minimum_progress`, and raw credential
fields. The returned summarizer is reserved for direct `hardContextReset` use.
The Agent must not put it in normal preflight or a `PipelineCondenser`.

The explicit active-main-profile `maxInputTokens` determines warning percentages,
even if the client's effective limit is larger. When that profile field is absent,
resolved main-model metadata may supply the denominator. Counting includes fixed
system/identity, host memory snapshot, skills, active history and usable tools.
Unavailable counts/limits remain unavailable; estimates are never billed usage.
The highest newly crossed threshold is persisted per reset generation. A failed
request or summary does not rearm warnings. Ignored warnings, estimates at/above
100%, event counts and elapsed turns do not reset or prevent a model request.

## Durable operation and model context

A voluntary operation uses the real sole `condense` call. Its optional
`message_to_future_self` is limited to 16,384 UTF-16 code units, with omitted,
empty and nonempty values kept distinct. It does not write memory files.
Mixed/duplicate reset requests return explicit failures without silently dropping
other tool calls.

The reset uses ordinary ActionEvent/ObservationEvent envelopes and a
`CondensationRequest.details` record containing version, trigger, input boundary
and original action/observation references. A `Condensation.reset` record points
to that request and is the commit. The derived active sequence is:

1. Normal fixed context.
2. Environment-source user-role text: `The agent triggered context condensation.`
3. The genuine assistant tool call, including its original ID and arguments.
4. The matching tool result, including the preserved optional message and recovery guidance.
5. Genuine user input that arrived after the request's consumed-input boundary.

There is no generated summary or historical keep-first/tail in that voluntary
sequence. The stored conversation history, accounting and files remain intact.
Recovery guidance asks the agent to take a deep breath, find/read its notes, regain
its bearings and continue the user's work. It acknowledges that the user may not
know what happened; it does not automatically send a channel message. Fixed host
memory is a snapshot and does not itself reload newly written notes.

On actual main-provider `LLMContextWindowExceedError`, the optional independent
hard fallback applies the full-view summarizer to eligible old history. The
environment notice identifies the provider error and precedes the generated
user-role summary; protected pending/rejected-request input and later text/media
follow. This path has no invented agent tool call. `LLMMalformedConversationHistoryError`
is distinct even when an `LLMResponseError` wraps the cause. Generic 400/413,
output-budget, authentication, rate-limit, content-policy and transport failures
alone do not authorize emergency reset.

The replay validates correlations, tool IDs, usable summary and protected input
before replacing the active View. Success must be committed before the next model
request sees a successful reset. A fully durable voluntary result may be completed
after restoration; an interrupted tool or paid fallback must not be blindly
executed again. Failure metadata must be secret-free. Missing fallback, exhausted
attempts, unusable summary or repeated actual provider rejection stops recoverably
with the source log retained. Summary-attempt accounting is independent of the
main call and cannot cause a repeated paid completion when its persistence fails.
A fixed prompt larger than the provider can accept is not repaired by deleting history.

Automatic recovery is bounded by the last durable hard-condensation request, whether
that request succeeded, failed, or was interrupted. No subsequent provider overflow
may start another automatic summary until a complete later main-model response has
been durably recorded with a valid request boundary. New user input, a new run,
restart, or a failure marker alone does not rearm it. Once a later main request
succeeds, another actual context-window error can start a fresh bounded recovery.
This prevents repeated paid attempts when a fixed prompt or unusable summary keeps
the provider rejecting context.

Durable failure records use stable SDK-authored text; they do not persist arbitrary
provider exception messages. For example, interrupted recovery records:
`Hard condensation was interrupted before its commit. History is intact; another automatic recovery requires a successful main-model response.`
Original errors may still propagate through the normal error boundary, but are not
copied verbatim into the operation-failure payload.

## Implementation and test map

| Area | Source | Focused regression file |
| --- | --- | --- |
| Tool contract/execution context | `src/tool/condense.ts` | `src/tool/__tests__/condense.test.ts` |
| Settings and independent materialization | `src/settings/condenser-settings.ts`, `src/settings/index.ts` | `src/settings/__tests__/agent-reset-settings.test.ts` |
| Advisory warning persistence/projection | `src/context/context-warnings.ts`, `agent-reset-condenser.ts` | `src/context/__tests__/context-warnings.test.ts` |
| Request/commit correlation, interrupted operations and bounded retry | `src/agent/context-reset.ts`, `src/llm/request-history.ts` | `src/agent/__tests__/context-reset.test.ts` |
| Reset metadata validation and View reconstruction | `src/event/condensation-metadata.ts`, `src/context/view.ts` | `src/context/__tests__/agent-reset-view.test.ts` |
| Native provider request replay | `src/agent/agent.ts`, native provider adapters | `src/agent/__tests__/agent-reset-provider-wire.test.ts` |
| Typed error routing and host rejection | `src/agent/agent.ts`, `src/conversation/local-conversation.ts` | `src/agent/__tests__/agent-reset.test.ts` and existing condensation lifecycle suites |

The files identify implementation and regression targets; listing them is not a
claim that every integration assertion has already passed. Existing Python View,
prompt, event-log and ordinary condenser oracles remain relevant to unchanged
paths; the new mode's selected behavior is target-policy evidence, not Python parity.

## Verification snapshot and remaining gates

The settings slice demonstrated 13 expected failures before implementation, then
passed all 50 new and 51 existing settings tests (101 total). Its focused lint,
typecheck snapshot and whitespace checks also passed.

The final local SDK checks on 2026-09-20 pass **1,057 tests with one skip**,
**seven drift tests**, and **68 offline live-harness tests**. Source, drift,
example and live-harness typechecks, ESLint, bundle and declaration builds pass.
Runnable examples pass in a deliberately credential-free environment; provider-
and remote-server-dependent examples skip. The canonical manifest passes its
existing parser with the new policies and unchanged source pin.

Independent integration review found and corrected old incomplete tool records
blocking a reset, and a committed-but-unacknowledged hard reset incorrectly being
marked failed. Both have RED/GREEN regressions. Six native OpenAI Chat, Responses
and Anthropic fake-transport tests verify two resets with restore, exact call/result
IDs and handoff, fixed context, late input, and signed/encrypted reasoning payloads.
These prove local serialization invariants, not live provider acceptance.

No blocking issue remains from the independent local review. CodeRabbit
reviewed SDK PR #51 and suggested replacing repeated linear event-position searches
with maps; that optimization is applied in reset replay and commit preparation.
CI passes on the implementation commit and is rerun for that review fix. No paid provider call or production service change is
established by these checks.

Only a reviewed, merged SDK commit may be vendored into the server. The server then
owns independent frozen fallback bindings, restoration/fork behavior, public-field
stripping and explicit protocol mapping of unsupported host maintenance. Product
`/condense` receipts, scheduler lanes and rollout remain host work. No existing
saved conversation is implicitly migrated or enabled by the SDK setting addition.

The shared manifest reserves `DEV-SERVER-010` for the follow-on server's opt-in
agent-reset behavior: independent hard-fallback binding and explicit unsupported
4xx host-maintenance response. The server contract and OpenAPI policy must define
and test that behavior after the SDK merge; registry presence alone does not mean
the server implementation or protocol change has landed. No new server extension
ID is needed for this existing route's explicitly selected mode.
