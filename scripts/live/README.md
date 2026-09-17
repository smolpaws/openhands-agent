# Live LLM regression suite

`models.json` is the complete model/route inventory and the execution configuration.
It lists native, OpenRouter, OpenHands app, and OpenHands eval targets separately,
including disabled routes and the reason each is disabled. Model IDs are route
specific. App is preferred where its catalog lists the model; eval is an explicit
configured fallback. A failed app request never silently switches to eval.

These are real, billable conversations. They prove provider/API behavior; the
upstream-derived deterministic tests remain the Python/TypeScript parity evidence.
Ordinary push/PR CI only builds, type-checks, and tests this harness offline.

## Run locally

```sh
npm run build
node --import tsx scripts/live/run.ts --list
node --import tsx scripts/live/run.ts --target native-deepseek-v4-pro --keychain
node --import tsx scripts/live/run.ts --all --keychain
```

Use an ID from `--list`. `--all` runs every enabled conversation, provider regression,
and local example target. `--matrix` prints enabled target IDs as a GitHub matrix
object for external tooling; the canonical workflow uses a single runner so the
configuration has one owner and every enabled target is attempted.

Credentials come from the exact `credential.env` name on the target. The optional
`--keychain` switch also looks up that target's `credential.keychainAccount` under
macOS Keychain service **`openhands`** when the environment value is absent. Keys are
injected into an in-memory `SecretStore`; profiles contain configuration only.
The app and eval credentials are separate even though both use provider ID
`litellm_proxy`. Never put keys in the JSON configuration or paste them into commands.

A target is `passed` only after its assertions complete. Missing credentials,
provider authorization failures, unavailable models, and provider outages are
reported as `unavailable`; assertion/runtime errors are `failed`. Explicitly
disabled routes remain visible in the report and are not attempted. Exit status
is **0** for all selected targets passing, **1** for a failed test, and **2** for
incomplete coverage without a test failure. Selecting a disabled target cannot
produce a passing result. Missing keys do not stop the runner from checking the
other enabled targets.

The runner writes `artifacts/llm/summary.json`, `summary.md`, and one JSON report
per selected target as it proceeds. Reports contain model/route IDs, status,
bounded failure categories, durations, and verification counts. Child process
stdout/stderr and raw provider exchanges are not published. Target workers receive
only their own key and have a hard deadline: four minutes for a regression target,
ten minutes for the example group. Provider requests also have individual limits.

## Conversation assertions

Each conversation operates on a disposable `git archive` of the selected SDK commit.
The agent's working directory is that repository snapshot. It uses the real built-in
file editor and terminal, with a narrow wrapper limiting effects to the requested
README edit and the two directory reads. The source checkout is never edited.

1. Read the entire `README.md` with the file editor and finish the first turn.
2. Replace the single exact word `Idiomatic` with `Straightforward`. Compare the
   complete file with the expected single replacement; require one actual edit.
3. Request exactly two terminal calls in one LLM response: `ls -1 src` and
   `ls -1 examples`. Both must begin before the harness releases either result.
   Compare their output with those directories in the real repository snapshot.
4. While the two tools are in progress, inject the exact user message
   **`finish with a finish tool call`**. The durable event history must preserve
   arrival order: tool actions, the user message, then the two observations.
5. Inspect the actual serialized HTTP request after provider adaptation. Both
   matching tool results must precede the new user instruction in LLM context.
   This checks native Anthropic, Gemini, OpenAI Responses, and chat-completions
   representations instead of trusting the internal event list alone.
6. Require an actual `finish` action and its successful matching observation.
   Ordinary assistant text is insufficient for this instruction.
7. Start a separate turn requesting the ordinary assistant reply `PLAIN-REPLY`.
   Once its provider request starts, append another user instruction before the
   response is consumed. The durable log must retain the late input before the
   reply; the next actual provider request must instead place that input after
   the reply that could not have seen it. Explicitly schedule that unconsumed
   input and require its requested finish call. This covers the separate plain
   response causality regression, including native Anthropic's assistant-prefill
   failure, as well as tool-time overlap.
8. Restore the JSON event history, continue once more, and prove no completed
   edits/tools or accounting entries are replayed. Each completion must have its
   own durable usage record. The report separately counts inspected tool-order
   and plain-response requests; a normal run takes nine provider completions.

The offline harness tests execute the real built-in tools through all four native
serializers with synthetic provider responses. Negative cases reject misplaced
input, missing or duplicate result IDs, false finishes, partial README reads,
single-tool responses, and corrupted wire identities. They also check target/result
handling without calling a provider:

```sh
npm run test:live-harness
```

## GitHub: one explicit label, one environment

On `smolpaws/openhands-agent`, apply **`llm-tests`** to a reviewed same-repository PR
into `main`. This runs the complete enabled suite, including existing provider
regressions and examples. There is no push, PR-open, or PR-update live trigger.
The old `test-examples` workflow is replaced by this suite.

**Applying `llm-tests` authorizes the exact PR revision to execute with billable LLM
credentials.** Review the code, dependencies, workflows, and target configuration
before applying it. The workflow requires repository write/maintain/admin permission
for both the label actor and any rerun actor. Fork PRs are rejected; bring reviewed
code onto a same-repository branch before authorizing a run.

The trusted `pull_request_target` workflow captures the label event's exact head
SHA, checks it against the current open PR, and rechecks immediately before the
credential-bearing step. Checkout uses that full SHA with persisted Git credentials
disabled. If the PR changes or the label is removed during setup, the run fails;
review the new revision and remove/reapply `llm-tests`. New commits do not inherit
an earlier label's execution authorization. The tested SHA appears in the Actions
summary and report, so a run never silently tests `main` instead of the labeled PR.

For a main-branch run, dispatch **Live LLM** from `main`:

```sh
gh workflow run llm.yml --repo smolpaws/openhands-agent --ref main
```

Dispatch is bound to the exact `main` SHA selected by GitHub. All live jobs use
only the **`LLM`** environment. Its existing `main` deployment branch rule is
compatible with the trusted base workflow; no wildcard PR branch exception is
needed. LLM secrets are exposed only to the live-run step, not installation/build
steps. The token has read-only repository permissions. Runs for the same PR queue;
the whole suite has a 180-minute limit and always attempts to upload the sanitized
`artifacts/llm/` reports, retained for 14 days.

Use these secret names in the canonical repository's **LLM** environment:

| Route | Environment secret |
| --- | --- |
| Native OpenAI | `OPENAI_API_KEY` |
| Native Anthropic | `ANTHROPIC_API_KEY` |
| Native Gemini | `GEMINI_API_KEY` |
| Native DeepSeek | `DEEPSEEK_API_KEY` |
| OpenCode | `OPENCODE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenHands app | `OPENHANDS_API_KEY_APP` |
| OpenHands eval | `OPENHANDS_API_KEY_EVAL` |

Keep one GitHub secret per credential, only in **LLM**. The workflow passes the
explicit APP and EVAL names directly to the runner. Local Keychain accounts retain
their existing names in `models.json`; the credential record maps each account to
its runner variable. Model IDs, enabled flags, and scenario settings come from
`models.json`; historical GitHub variables do not override this inventory.

The initial workflow installation must land on `main` before its label trigger is
available. The `llm-tests` repository label and additional LLM secrets are separate
GitHub setup items; missing credentials deliberately remain visible as incomplete
coverage instead of silently skipping tests.

## Existing provider regressions and examples

The suite retains these scripts as explicit scenario targets. Each is credential
checked before launch, so older scripts that exit successfully on missing keys
cannot become false passing results in the suite. Their direct commands remain
available for focused local investigation.

- `deepseek-flash.ts` (`npm run live:deepseek-flash`): exact text, concurrent input
  during a real tool call, restored continuation, and provider-exact usage/cost
  accounting. Native DeepSeek supplies token counts; calculated costs retain their
  pricing source, and missing fields/costs remain unknown. Requires
  `DEEPSEEK_API_KEY`; `DEEPSEEK_MODEL` overrides its direct-script model.
- `anthropic-cache-smoke.ts` (`npm run live:anthropic-cache-smoke`): cold cache
  writes, real cache reads on continuation and restored history, and exact token
  accounting. The default suite target uses eval proxy Haiku with a one-hour TTL.
  The nonce-bearing prefix exceeds Haiku's cache minimum. One-hour runs require
  provider-reported `ephemeral_1h_input_tokens`, not an inferred TTL. A zero-hit
  run fails. Native direct invocation uses `ANTHROPIC_API_KEY`; proxy invocation
  uses `LLM_PROVIDER_ID=litellm_proxy`, `LLM_MODEL`, `LLM_BASE_URL`, and
  `LITELLM_PROXY_API_KEY`. `ANTHROPIC_CACHE_TTL` accepts `5m` or `1h` for direct
  invocation. When unset, the profile omits this optional field and requests retain
  Anthropic's five-minute default; outgoing markers match the effective duration.
  One-hour cold responses must report at least 4,096 one-hour input tokens, and
  each response's one-hour writes must equal its total cache writes.
- `openai-responses-reasoning.ts`: multi-turn OpenAI Responses reasoning replay,
  including full and minimal replay paths. The suite uses `--strict`: every turn
  must return text and encrypted reasoning, and subsequent requests must preserve
  encrypted continuation items. Its diagnostic raw request/response
  files are placed in temporary storage and removed by the suite, never uploaded.
- `examples/native-openai-tools.ts`: real native tool invocation, README editing,
  and a finish tool call.
- `examples/native-gemini-tools.ts`: real native tool invocation, signed-thought
  replay, and a finish tool call.
- `examples/*.ts`: remaining local examples run as a separate configured group,
  including real hello-world and conversation-patterns completions. Native tool
  examples are the separate targets above. `remote-workspace.ts` is explicitly
  excluded and reported: it requires a separately provisioned agent-server and
  does not test an LLM conversation.

`llm-smoke.mjs` remains a minimal OS-keyring diagnostic for a single completion;
the new conversation suite covers that basic provider viability along with actual
tools, concurrent input, serialization, restoration, and accounting assertions.
