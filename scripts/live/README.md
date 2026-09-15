# Live provider tests

These scripts use real, billable provider APIs. They prove SDK/provider viability;
they do not replace deterministic tests or Python/TypeScript parity checks.

## DeepSeek v4 Flash

Set `DEEPSEEK_API_KEY` in your process environment, then run:

```sh
npm run live:deepseek-flash
```

`DEEPSEEK_MODEL` optionally overrides the default `deepseek-v4-flash`. The endpoint
is fixed to `https://api.deepseek.com`. Credentials use the existing example helper's
in-memory `SecretStore`; they are never written to profiles or snapshots.

The test checks an exact text response, a real tool call with concurrent user input,
and continuation from a JSON-restored event history. It asserts the latest requested
answer, preserved arrival order, and exactly one tool execution across restoration.
Only a synthetic in-memory echo tool and `finish` are exposed to the model.
Missing credentials fail the test rather than reporting a skipped success. Requests
are bounded by a 45-second timeout, 4,096 output tokens, 12 calls and a 3-minute test
deadline. Logs contain only assertions and model/request/effect counts.

On canonical `smolpaws/openhands-agent`, dispatch **Live LLM** from `main`:

```sh
gh workflow run llm.yml --repo smolpaws/openhands-agent --ref main
```

The GitHub environment is **`LLM`**, with secret `DEEPSEEK_API_KEY` and optional
variable `DEEPSEEK_MODEL`. Its deployment policy permits the `main` branch only;
the workflow also checks the canonical repository and branch. The secret is scoped
to the live-test step. The workflow runs on manual dispatch, with a six-minute job
timeout and serialized runs. It does not expose credentials to pull-request code.
Ordinary CI type-checks these scripts without credentials or API calls.

## Existing scripts

- `llm-smoke.mjs` (`live:llm`) resolves credentials from the local OS keyring.
- `openai-responses-reasoning.ts` and `anthropic-cache-smoke.ts` use environment
  credentials through the same example helper; missing keys currently skip them.
- The separate **Examples** workflow uses the existing `examples` environment
  with OpenAI, Anthropic and Gemini secrets. It is independent of `LLM`.
