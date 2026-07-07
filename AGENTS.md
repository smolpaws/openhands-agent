# OpenHands Agent Notes

- Work is tracked in Beads (`bd`). Check open Beads before starting follow-up work.
- The examples GitHub Environment now provides `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY` to `.github/workflows/examples.yml`.
- `examples/_shared/exampleProfile.ts` currently always calls `createLlmClientFromProfile`, so examples exercise OpenAI-compatible chat clients only. Gemini/Anthropic coverage needs provider-specific examples or the `live:*` smoke scripts.
- Gemini `thoughtSignature` round-trip is verified live for Gemini 3.x models (`gemini-3.5-flash`, `gemini-3.1-pro-preview`) using `thinkingConfig.thinkingLevel`. Gemini 2.5 models reject `thinkingLevel` with HTTP 400; if `reasoningEffort` must support Gemini 2.5, add an older integer `thinkingBudget` branch.
