# OpenHands upstream drift

- **Repository:** `OpenHands/software-agent-sdk`
- **Pinned:** `966340979be26c2162e9ab8805557b715e1f1a78` (2026-06-23T23:08:24+02:00)
- **Candidate:** `b061336b800712dcb86b9c9d829910a89c0867d0` (2026-06-27T12:12:00+08:00)
- **Commits:** 20 total; 20 first-parent review units

## Scope summary

| Target | Commit units | Files | Tests | Examples | Modules | Policy hints |
|---|---:|---:|---:|---:|---|---|
| sdk | 11 | 66 | 17 | 3 | `17_image_input`, `32_configurable_security_policy`, `40_acp_agent_example`, `agent`, `apply_patch`, `context`, `conversation`, `delegate`, `dependencies`, `file_editor`, `gemini`, `llm`, `observability`, `plugin`, `pyproject`, `settings`, `tests`, `workspace` | `DEV-SDK-002`, `DEV-SDK-005`, `EXC-SDK-001` |
| server | 8 | 24 | 9 | 0 | `api`, `config`, `conversation`, `dependencies`, `event`, `openai`, `plugins`, `pyproject`, `test_api_authentication`, `test_conversation_tags`, `test_env_parser`, `test_event`, `test_llm`, `test_plugins`, `test_webhook_subscriber` | — |

## First-parent changes

| Commit | Date | Subject | Target | Modules | Files | Disposition |
|---|---|---|---|---|---:|---|
| `44199403940a` | 2026-06-24 | Use provider-fetchable icon URL in image examples (#3865) | sdk | `17_image_input`, `40_acp_agent_example`, `tests` | 3 | UNREVIEWED |
| `88364297f0f2` | 2026-06-24 | Clarify temporary PR artifacts policy (#3861) | — | — | 0 | ignored/unmapped |
| `22408f65ffcc` | 2026-06-24 | ci(version-bump-prs): also bump agent-server pin in typescript-client (#3864) | — | — | 0 | ignored/unmapped |
| `98201f9fcd17` | 2026-06-25 | fix(agent-server): make webhook retry sleep patchable per-instance (#3866) | server | `conversation`, `test_webhook_subscriber` | 2 | UNREVIEWED |
| `1cdf6485aa84` | 2026-06-25 | fix(llm): recover softly from Anthropic content-policy blocks (#3873) | sdk | `agent`, `llm` | 7 | UNREVIEWED |
| `b54c53b02c95` | 2026-06-25 | Skip integration setup for unrelated labels (#3880) | — | — | 0 | ignored/unmapped |
| `55ee98109acd` | 2026-06-25 | Notify proj-agent when SDK release prep starts (#3879) | — | — | 0 | ignored/unmapped |
| `5eab7198d335` | 2026-06-25 | feat: auto-load installed and local plugins into conversations (#3846) | sdk | `conversation`, `plugin` | 5 | UNREVIEWED |
| `f8ee47d8a994` | 2026-06-25 | feat: add plugins-only marketplace catalog endpoint (#3847) | server | `api`, `plugins`, `test_plugins` | 4 | UNREVIEWED |
| `217b2cf83aab` | 2026-06-25 | feat: add installed-plugin management router (#3848) | server | `plugins`, `test_plugins` | 3 | UNREVIEWED |
| `944284310d9a` | 2026-06-25 | [codex] Fix subscription retry temperature handling (#3840) | sdk | `llm` | 2 | UNREVIEWED |
| `afd248fe7de3` | 2026-06-26 | Replace silent assert failures with structured DiffError raises in apply_patch, and fixe a race condition and unhandled telemetry crash in event_service (#3382) | sdk | `apply_patch`, `gemini` | 4 | UNREVIEWED |
| `afd248fe7de3` | 2026-06-26 | Replace silent assert failures with structured DiffError raises in apply_patch, and fixe a race condition and unhandled telemetry crash in event_service (#3382) | server | `event`, `test_event` | 2 | UNREVIEWED |
| `aa0494b413b9` | 2026-06-26 | refactor(sdk): build dynamic system-message suffix via the prompt registry (#3837) | sdk | `agent`, `context` | 5 | UNREVIEWED |
| `bbb6c08973e2` | 2026-06-26 | refactor(sdk): remove Jinja prompts superseded by the Python prompt registry (#3796) | sdk | `32_configurable_security_policy`, `agent`, `context`, `delegate` | 21 | UNREVIEWED |
| `0c6d01b6db48` | 2026-06-26 | ci: remove obsolete sdk_ref default update from prepare-release (#3887) | — | — | 0 | ignored/unmapped |
| `c3441f8e67c8` | 2026-06-26 | Release v1.29.3 (#3888) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | UNREVIEWED |
| `c3441f8e67c8` | 2026-06-26 | Release v1.29.3 (#3888) | server | `dependencies`, `pyproject` | 2 | UNREVIEWED |
| `095883242a0b` | 2026-06-26 | Expose conversation observability span names on agent server (#3881) | sdk | `conversation`, `observability`, `settings` | 11 | UNREVIEWED |
| `095883242a0b` | 2026-06-26 | Expose conversation observability span names on agent server (#3881) | server | `event`, `openai`, `test_api_authentication`, `test_conversation_tags` | 5 | UNREVIEWED |
| `b0dff5e6783f` | 2026-06-26 | [codex] Align subscription Codex models with ACP registry (#3808) | sdk | `llm` | 2 | UNREVIEWED |
| `b0dff5e6783f` | 2026-06-26 | [codex] Align subscription Codex models with ACP registry (#3808) | server | `test_llm` | 1 | UNREVIEWED |
| `b4bfa7a823cd` | 2026-06-26 | feat: add OH_LEASE_TTL_SECONDS to make conversation lease TTL configurable (#3898) | server | `config`, `conversation`, `event`, `test_env_parser`, `test_event` | 5 | UNREVIEWED |
| `b061336b8007` | 2026-06-27 | fix(file_editor): preserve new_str whitespace in str_replace fallback (#3882) | sdk | `file_editor` | 2 | UNREVIEWED |

## Explicitly ignored repository paths

- .agents/skills/sdk-release/SKILL.md
- .github/scripts/update_sdk_ref_default.py
- .github/workflows/integration-runner.yml
- .github/workflows/prepare-release.yml
- .github/workflows/version-bump-prs.yml
- AGENTS.md

## Review summary

- **PORT:** 0
- **NO_TARGET_CHANGE:** 0
- **DEVIATION:** 0
- **EXCLUDED:** 0
- **DEFERRED:** 0
- **UNREVIEWED:** 19
