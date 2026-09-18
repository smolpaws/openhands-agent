# Condensation port evidence

Date: 2026-09-18. Source authority is the unchanged canonical commit in [upstream.json](upstream.json). This completes an existing SDK gap at that pin; it is not a pin advance. Frozen interval reviews remain historical records. Tracking: SmolPaws `smolpaws-iizg.2` through `.7` and `smolpaws-xtv.3`; server consumption follows SDK review and merge.

## Source and target mapping

Paths below are relative to the pinned Python repository. Tests and generated fixtures are the evidence; this table bounds this change rather than claiming global SDK parity.

| Python source and original tests | TypeScript implementation/evidence | Disposition |
| --- | --- | --- |
| `context/view/view.py`, `manipulation_indices.py`, `properties/*.py`; `tests/sdk/context/view/` | `src/context/view.ts`, `manipulation-indices.ts`, `view-properties.ts`; 40 generated Python View cases plus index/provenance regressions | PORT; retain DEV-SDK-009 request projection |
| `context/condenser/base.py`, `pipeline_condenser.py`, `no_op_condenser.py`; corresponding condenser unit tests | `src/context/condenser.ts`, existing and new condenser tests | PORT; synchronous compatibility retained with awaited async members |
| `context/condenser/llm_summarizing_condenser.py`, `utils.py`, summary Jinja template; original summarizer/utility tests | `llm-summarizing-condenser.ts`, `condenser-utils.ts`, `condenser-prompt.ts`; original threshold/cut/reset assertions and generated prompt fixtures | PORT; DEV-SDK-011 defaults |
| `agent/agent.py` overflow/malformed-history catches and metadata preparation; `tests/sdk/agent/` | `src/agent/agent.ts`; `condensation.test.ts` and existing causality/profile suites | PORT; DEV-SDK-007/008/009 integration |
| `conversation/impl/local_conversation.py::condense`, remote conversation operation | Local/RemoteConversation `.condense()`; `conversation/__tests__/condense.test.ts` | PORT; EXT-SDK-003 step serialization preserved |
| `settings/model.py` and `tests/sdk/test_settings.py` | validated `src/settings/condenser-settings.ts`, materializer tests | PORT with DEV-SDK-004 independent profile references and DEV-SDK-011 defaults |
| `llm/llm.py` and pinned LiteLLM dependency behavior | native error mapping and input budget capabilities | PORT for typed provider failures; DEV-SDK-010 for tokenizer/model coverage |
| `event/llm_convertible/action.py`, null-action/error View test | nullable/default-null action and omitted-null restore without inventing executable payloads; generated Python EventLog round trips | PORT |
| `tests/integration/` condenser c01–c05 cases | deterministic integration cases and opt-in live harness scenarios | PORT; live viability is separate from deterministic parity |
| Python agent-server condensation route/service/event-service | owned by `smolpaws/packages/openhands-agent-server` | DELEGATED until SDK merge and verified re-vendor |

SDK source paths above are under `openhands-sdk/openhands/sdk/`. The original Python View suite passes 147 cases. Original condenser tests currently execute as **75 parameterized cases**, rather than the earlier planning inventory of 66 test functions. The original c02 case exercises hard context reset.

## Behavioral contract

- Rebuild the model View with all four Python history properties. Safe cuts cannot split a tool response batch, action/result pair or thinking loop. Durable history remains intact, including pending/orphan records whose recovery belongs to the server.
- Strict event and token thresholds, explicit requests, minimum 10% progress and half-budget targets follow source. The effective token limit is the smaller configured condenser cap and available agent input limit. Count with the agent client, summarize with the condenser client.
- The TypeScript class, validated settings and explicit `defaultCondenser()` factory all default to 1000/2 under DEV-SDK-011. The pinned Python class/settings remain 240/2 and its standard-agent/sub-agent factory remains 80/4. Explicit saved values are preserved; only omitted fields receive the target defaults.
- A soft cut with no progress returns the original View. **Delayed condensation does not mean a background job.** A later synchronous step can succeed when its history has safe boundaries.
- Hard reset summarizes the whole current View with offset zero, removing keep-first protection. The first attempt is untruncated; later attempts multiply the longest event preview ceiling by 0.8, with five total reset attempts. This follows a failed ordinary cut/summary attempt, which may itself have called the LLM.
- Prompt/event previews match the pinned Jinja and Python string forms, including 500-character previews and Unicode clipping. Summary responses use the first content block if it is text, as in source.
- Context overflow and malformed history are distinct typed failures. With a capable condenser they append a request and return. Condensation is another step, then main completion resumes. Unrelated authentication, rate, output-budget or generic payload-size errors are not automatic condensation triggers.
- Every summary attempt records its actual profile and known provider metadata once. Unknown usage/cost stays unknown. Persistence failures propagate without another provider attempt. Main completion accounting remains separate.
- Explicit condensation does not resume a paused conversation or claim queued input was answered. Step-level serialization prevents overlap with tool batches, profile preparation and ordinary completions.

## Differential evidence and reproduction

`generate-python-view-oracle.py`, `generate-python-condenser-oracle.py` and `generate-python-condensation-wire-oracle.py` under `scripts/parity/` verify the checkout revision and imported source path against the manifest pin before evaluating cases. Their committed fixtures are compared by TypeScript tests. The View oracle covers duplicates, matching, complete batches/loops, safe indices and summary replay. The prompt oracle covers canonical event string rendering, complete Jinja whitespace and truncation; it is not a second handwritten expected implementation. The condensation wire oracle writes and reopens nine actual Python EventLogs, then checks TypeScript import, on-disk restore, summary replay and message projections. Native tool actions without a Python discriminator use their canonical tool name for the action preview; arbitrary host/MCP class labels are not reconstructed.

Run the original Python unit suite from a detached checkout of the manifest commit with a matching environment:

```sh
PYTHONPATH=openhands-sdk:openhands-tools:openhands-workspace python -m pytest tests/sdk/context/condenser -q -o addopts=''
```

The existing local Python environment passed all 75 cases during this port. Each implementation slice demonstrated failing adapted tests before code: View properties, provider errors/budgets, summarizer, settings and lifecycle. Additional failing regressions cover async persistence races, null actions on restore and manual-step input markers. The shared SDK suite and required packaging/drift checks must pass before merge; live tests never substitute for these checks.

## Deliberate differences and practical limits

[DEV-SDK-004/007/008/009/010/011 and EXT-SDK-003](../docs/TRANSPILE_CONTRACT.md) govern profile resolution, accounting, opaque reasoning, concurrent input, token estimates, event defaults and host boundaries. Preflight counts include the fixed prompt/context and tools, since this SDK renders them outside the stored View. Full host context is retained; history condensation cannot fix a fixed prompt that itself exceeds the model limit.

Two source quirks remain intentionally compatible: direct condenser construction accepts zero/negative integer token caps, and a very small custom hard-reset scaling factor can reach a zero preview limit, which Python treats as unlimited. The standard 0.8 scaling is unchanged. Focused tests and direct execution of the pinned Python mock cases lock this behavior; positivity validation or clamping would be a separate policy change.

Token counts are local estimates. Unsupported modalities return unavailable, leaving event/manual/provider-error recovery usable. Runtime model metadata has bounded lookup/cache behavior; custom route limits are not inferred from another endpoint's model name. The pinned dependency catalog is a snapshot, not a claim about today's provider limits. Existing explicit limits remain authoritative. Python's joint input/output-window clamping is not implemented by this input-counting slice; native output-limit controls and provider-error recovery remain distinct.

No production runtime was restarted as part of this SDK port. The server must consume a packaged, provenance-verified SDK commit after review/merge. Product `/condense` dispatch and Google/Cloudflare onboarding are separate host work. Fast-Jev evaluation (`smolpaws-eh4z`) remains blocked on standard condensation completion.

## Event-default policy update

On 2026-09-18, the requested target defaults changed to 1000/2 for the class, settings and standard factory. DEV-SDK-011 records this intentional difference; the canonical Python pin is unchanged. `defaultCondenser()` is an exported SDK helper with no internal runtime caller. Settings-driven construction uses `materializeCondenser()`, so both entry paths are covered independently. The Python helper is used by `openhands-tools/openhands/tools/preset/default.py` and `openhands-sdk/openhands/sdk/subagent/registry.py`.

Focused target tests cover the three construction paths, the strict 1000/1001 event boundary, and JSON/materialization preservation of explicit 240/2 and 80/4 settings. Existing token, request, provider-recovery and safe-cut tests retain their explicit configurations. These default assertions are target-policy evidence, not claims that Python uses the same values.

## Verification at SDK review

The implementation review passed 883 SDK tests (69 files), 68 offline live-harness tests, seven drift-tool tests, source/drift/live/example type checks, ESLint, bundle/declaration builds, runnable examples, the committed projection oracle and packed provenance check. Original Python checks passed 147 View cases and 75 condenser cases. Generated View, prompt and EventLog fixtures reproduced byte-for-byte. Independent reviews covered View/cut/reset semantics, provider error/counting metadata, profile/accounting/concurrency and the live runner.

After explicit authorization on 2026-09-18, the bounded `native-deepseek-v4-1-flash --condensation forced` live smoke passed in 17.3 seconds: nine requests, two summary completions/condensations, eight forgotten events, seven continuations and three executed tools. It verified actual condensation, tool continuation, restored summaries/accounting and independent summary accounting. This was forced condensation, not a claim of a real provider context-overflow response; native overflow envelopes remain separately covered by deterministic transport tests. Other real-provider scenarios were not run.
