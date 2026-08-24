# OpenHands upstream drift

- **Repository:** `OpenHands/software-agent-sdk`
- **Pinned:** `54dfbc551408d10de54eb8ac5612bae6d3f99d16` (2026-07-29T08:29:42-04:00)
- **Candidate:** `322dec7d777497e376f81e093ed1eb0196bbbb39` (2026-08-27T09:37:32-04:00)
- **Commits:** 123 total; 123 first-parent review units

## Scope summary

| Target | Commit units | Files | Tests | Examples | Modules | Policy hints |
|---|---:|---:|---:|---:|---|---|
| sdk | 84 | 352 | 146 | 5 | `56_structured_output`, `57_prompt_hooks`, `58_ask_oracle_tool`, `AGENTS`, `__init__`, `agent`, `ask_oracle`, `browser_use`, `context`, `conversation`, `dependencies`, `event`, `extensions`, `file_editor`, `git`, `hooks`, `io`, `llm`, `mcp`, `observability`, `persisted_settings_baselines`, `plugin`, `preset`, `profiles`, `pyproject`, `repository`, `security`, `settings`, `subagent`, `task`, `terminal`, `test-infrastructure`, `test_cloud_workspace`, `test_cloud_workspace_automation_tags`, `test_cloud_workspace_repos`, `test_examples`, `test_preset_default`, `test_settings`, `test_task_outcome`, `test_tool_name_consistency`, `tool`, `utils`, `workspace` | `DEV-SDK-001`, `DEV-SDK-002`, `DEV-SDK-004`, `DEV-SDK-005`, `EXC-SDK-001` |
| server | 63 | 184 | 78 | 0 | `AGENTS`, `README`, `_secrets_exposure`, `agent_profiles`, `api`, `bash`, `canvas_extensions`, `config`, `conversation`, `dependencies`, `docker`, `event`, `file`, `init`, `mcp`, `mcp_oauth_store`, `models`, `persistence`, `profiles`, `provider_connections`, `pyproject`, `repository`, `settings`, `sockets`, `sub_agents`, `telemetry`, `telemetry_types`, `test-infrastructure`, `test_agent_launch_additions`, `test_agent_profile_conv_start`, `test_agent_profiles`, `test_auto_title_span_metadata`, `test_bash`, `test_canvas_extensions`, `test_check_issue_readiness`, `test_check_persisted_settings_compat`, `test_check_pr_description`, `test_config`, `test_conversation`, `test_conversation_info_model`, `test_conversation_lease_behavior`, `test_conversation_restore_behavior`, `test_conversation_service_plugin`, `test_conversation_tags`, `test_credential_binding`, `test_event`, `test_event_router_websocket`, `test_event_streaming`, `test_file`, `test_goal_loop`, `test_init`, `test_mcp`, `test_mcp_oauth_store`, `test_openapi_discriminator`, `test_persistence_secret_detection`, `test_profile_store_persistence_dir`, `test_profiles`, `test_refresh_linked_pr_checks`, `test_remote_conversation_live_server`, `test_settings`, `test_stuck_detector`, `test_sub_agents`, `test_switch_llm_survives_reload`, `test_webhook_subscriber`, `test_websocket_first_message_auth` | `DEV-SERVER-003`, `DEV-SERVER-004`, `DEV-SERVER-005` |

## First-parent changes

| Commit | Date | Subject | Target | Modules | Files | Disposition |
|---|---|---|---|---|---:|---|
| `f862d76b21b1` | 2026-07-29 | chore(release): remove OpenHands Index checklist item (#4302) | — | — | 0 | ignored/unmapped |
| `f0bfc1f86865` | 2026-07-29 | fix(ci): bind release smoke container port (#4305) | — | — | 0 | ignored/unmapped |
| `6387406b99db` | 2026-07-29 | fix(security): stop logging runtime command contents (#4280) | sdk | `terminal`, `workspace` | 6 | NO_TARGET_CHANGE |
| `6387406b99db` | 2026-07-29 | fix(security): stop logging runtime command contents (#4280) | server | `bash`, `sockets`, `test_bash`, `test_event_router_websocket`, `test_websocket_first_message_auth` | 5 | NO_TARGET_CHANGE |
| `4b132eddb6cf` | 2026-07-29 | feat: add MCPServer.enabled to switch a server off without removing it (#4307) | sdk | `agent`, `conversation`, `mcp`, `test_settings` | 8 | NO_TARGET_CHANGE |
| `bf57d16f3dde` | 2026-07-30 | Release v1.39.1 (#4310) | sdk | `dependencies`, `pyproject`, `settings`, `workspace` | 5 | NO_TARGET_CHANGE |
| `bf57d16f3dde` | 2026-07-30 | Release v1.39.1 (#4310) | server | `dependencies`, `pyproject`, `test_settings`, `test_sub_agents` | 4 | NO_TARGET_CHANGE |
| `6ce4953e943e` | 2026-07-30 | feat(llm): verify kimi-for-coding (Kimi Code membership) (#4150) | sdk | `llm` | 1 | NO_TARGET_CHANGE |
| `64042bce9f62` | 2026-07-30 | fix(sdk): respect subscription validator composition (#3953) | sdk | `conversation`, `llm`, `test_settings` | 6 | NO_TARGET_CHANGE |
| `9d3a784c30ea` | 2026-07-30 | chore(deps): bump joserfc from 1.6.4 to 1.6.8 (#4306) | sdk | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `9d3a784c30ea` | 2026-07-30 | chore(deps): bump joserfc from 1.6.4 to 1.6.8 (#4306) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `d44e8750413e` | 2026-07-30 | chore(ci): remove QA Changes workflows (#4299) | — | — | 0 | ignored/unmapped |
| `b6cd67ebae3c` | 2026-07-30 | fix(agent-server): keep secrets out of workspace persistence (#3990) | server | `persistence`, `test_profile_store_persistence_dir` | 2 | NO_TARGET_CHANGE |
| `6d597ff7d5d3` | 2026-07-30 | Mark deprecated compatibility aliases (#4004) | sdk | `conversation`, `profiles`, `subagent` | 6 | NO_TARGET_CHANGE |
| `6d597ff7d5d3` | 2026-07-30 | Mark deprecated compatibility aliases (#4004) | server | `mcp`, `models`, `sub_agents`, `test_mcp`, `test_openapi_discriminator` | 5 | NO_TARGET_CHANGE |
| `9acb5e52db4f` | 2026-07-31 | Use the right branch name in release branches (#4073) | — | — | 0 | ignored/unmapped |
| `ac225e548535` | 2026-07-31 | refactor(llm): add LiteLLM-backed provider abstraction (#2363) | sdk | `AGENTS`, `llm` | 11 | NO_TARGET_CHANGE |
| `ac225e548535` | 2026-07-31 | refactor(llm): add LiteLLM-backed provider abstraction (#2363) | server | `test_conversation_restore_behavior` | 1 | NO_TARGET_CHANGE |
| `d9f3e1675714` | 2026-07-31 | feat(sdk): classify conversation errors (#4316) | sdk | `agent`, `conversation`, `event` | 7 | PORT |
| `d9f3e1675714` | 2026-07-31 | feat(sdk): classify conversation errors (#4316) | server | `event`, `telemetry` | 5 | NO_TARGET_CHANGE |
| `2f27653959f7` | 2026-07-31 | Release v1.40.0 (#4324) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `2f27653959f7` | 2026-07-31 | Release v1.40.0 (#4324) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `abeb884cacac` | 2026-08-01 | fix(acp): surface Claude Opus 5 in Claude Code model picker (#4326) | sdk | `settings` | 2 | DEVIATION |
| `187aa7ede1fc` | 2026-08-03 | fix: PATCH /api/settings loads the profile's LLM when setting active_profile (#4319) | server | `_secrets_exposure`, `agent_profiles`, `profiles`, `settings`, `test_agent_profiles`, `test_settings` | 6 | NO_TARGET_CHANGE |
| `8ce9300c6219` | 2026-08-03 | chore(sdk): deprecate AgentBase.model_dump_succint (#4328) | sdk | `agent` | 2 | NO_TARGET_CHANGE |
| `4053be030b30` | 2026-08-03 | docs: refresh AGENTS.md guidance (#4335) | sdk | `AGENTS`, `workspace` | 3 | NO_TARGET_CHANGE |
| `2b38718ad34a` | 2026-08-03 | Delete assign-reviews.yml (#4337) | — | — | 0 | ignored/unmapped |
| `d4b16cdb4ba0` | 2026-08-03 | Bound agent-server webhook delivery memory (#4323) | server | `config`, `conversation`, `telemetry`, `test_webhook_subscriber` | 4 | NO_TARGET_CHANGE |
| `973c35134f0b` | 2026-08-03 | fix(git): demote expected command failures to debug (#4341) | sdk | `git` | 2 | NO_TARGET_CHANGE |
| `8c2297b19835` | 2026-08-04 | chore(deps): bump pypdf from 6.10.2 to 6.14.2 (#4345) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `8c2297b19835` | 2026-08-04 | chore(deps): bump pypdf from 6.10.2 to 6.14.2 (#4345) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `c8a65f0db7c4` | 2026-08-04 | fix(sdk): nudge before hard-terminating on a repeating action-error pattern (#4332) | sdk | `conversation` | 3 | PORT |
| `c8a65f0db7c4` | 2026-08-04 | fix(sdk): nudge before hard-terminating on a repeating action-error pattern (#4332) | server | `test_stuck_detector` | 1 | NO_TARGET_CHANGE |
| `a6c908bc692b` | 2026-08-04 | Set AI_AGENT for SDK subprocesses (#4366) | sdk | `utils` | 2 | NO_TARGET_CHANGE |
| `4d0b53cf7c27` | 2026-08-04 | fix(mcp): reconcile live agent tool snapshots (#4367) | sdk | `agent`, `conversation`, `mcp` | 8 | NO_TARGET_CHANGE |
| `4d0b53cf7c27` | 2026-08-04 | fix(mcp): reconcile live agent tool snapshots (#4367) | server | `mcp_oauth_store` | 1 | NO_TARGET_CHANGE |
| `c789a9a907aa` | 2026-08-04 | fix(observability): mark utility LLM spans (title generation, ask_agent) (#4359) | sdk | `conversation`, `observability` | 5 | NO_TARGET_CHANGE |
| `c789a9a907aa` | 2026-08-04 | fix(observability): mark utility LLM spans (title generation, ask_agent) (#4359) | server | `conversation`, `test_auto_title_span_metadata` | 2 | NO_TARGET_CHANGE |
| `1ae6a1614a4c` | 2026-08-04 | refactor(observability): stop depending on lmnr to propagate trace context into tool workers (#4360) | sdk | `agent` | 2 | NO_TARGET_CHANGE |
| `0c8f97aab8a2` | 2026-08-04 | chore(deps): bump aiohttp from 3.13.4 to 3.14.3 (#4312) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `0c8f97aab8a2` | 2026-08-04 | chore(deps): bump aiohttp from 3.13.4 to 3.14.3 (#4312) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `4f3032f2ddcc` | 2026-08-05 | feat: report accumulated LLM cost in the automation completion callback (#4311) | sdk | `conversation`, `test_cloud_workspace`, `workspace` | 11 | NO_TARGET_CHANGE |
| `c1877b441296` | 2026-08-05 | Release v1.40.1 (#4377) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `c1877b441296` | 2026-08-05 | Release v1.40.1 (#4377) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `06a7d726611f` | 2026-08-05 | feat(agent-server): Canvas Extensions manifest and containment [1/4] (#4361) | server | `canvas_extensions` | 5 | NO_TARGET_CHANGE |
| `ecf417c18e58` | 2026-08-05 | fix(observability): give delegate conversations their own detached Laminar trace (#4378) | sdk | `observability`, `task` | 4 | NO_TARGET_CHANGE |
| `b35c2fee8b4c` | 2026-08-06 | fix(browser): a browser tool that cannot start should not fail the conversation (#4342) | sdk | `browser_use` | 2 | NO_TARGET_CHANGE |
| `da6f5463be93` | 2026-08-06 | feat(sdk): track requested_ref alongside resolved_ref in InstallationInfo [2/4] (#4375) | sdk | `extensions` | 4 | PORT |
| `ca9652bff38a` | 2026-08-06 | feat(agent-server): Canvas Extensions installation persistence [3/4] (#4364) | server | `canvas_extensions` | 4 | NO_TARGET_CHANGE |
| `78ef73c5052c` | 2026-08-06 | feat(agent-server): Canvas Extensions staged refresh (check/apply) [4/4] (#4374) | server | `canvas_extensions` | 5 | NO_TARGET_CHANGE |
| `d90d94f7fad1` | 2026-08-06 | fix(observability): keep the conversation object out of TOOL span input (#4379) | sdk | `agent` | 2 | NO_TARGET_CHANGE |
| `4e7d5b0fd9a7` | 2026-08-06 | test: stop ambient LMNR env vars deciding what the tracing tests measure (#4390) | sdk | `agent` | 2 | NO_TARGET_CHANGE |
| `199618a59b08` | 2026-08-06 | chore: remove deprecated features past their 1.41.0 removal deadline (#4394) | sdk | `conversation`, `profiles`, `subagent` | 6 | NO_TARGET_CHANGE |
| `199618a59b08` | 2026-08-06 | chore: remove deprecated features past their 1.41.0 removal deadline (#4394) | server | `mcp`, `models`, `test_conversation`, `test_mcp`, `test_openapi_discriminator` | 6 | NO_TARGET_CHANGE |
| `ca46719d5e9a` | 2026-08-06 | Release v1.41.0 (#4393) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `ca46719d5e9a` | 2026-08-06 | Release v1.41.0 (#4393) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `30d4cac7d16a` | 2026-08-06 | chore(acp): bump pinned claude-agent-acp to 0.65.0, codex-acp to 1.1.9 (#4391) | sdk | `agent`, `settings`, `test_settings` | 3 | DEVIATION |
| `30d4cac7d16a` | 2026-08-06 | chore(acp): bump pinned claude-agent-acp to 0.65.0, codex-acp to 1.1.9 (#4391) | server | `docker` | 1 | NO_TARGET_CHANGE |
| `443a462309df` | 2026-08-06 | feat(observability): emit LLM and TOOL spans for ACP turns (#4376) | sdk | `agent`, `test-infrastructure` | 4 | DEVIATION |
| `443a462309df` | 2026-08-06 | feat(observability): emit LLM and TOOL spans for ACP turns (#4376) | server | `test-infrastructure` | 1 | NO_TARGET_CHANGE |
| `da03ee405993` | 2026-08-06 | Feat: structured output (#4207) | sdk | `agent`, `dependencies`, `mcp`, `pyproject`, `tool` | 11 | NO_TARGET_CHANGE |
| `da03ee405993` | 2026-08-06 | Feat: structured output (#4207) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `701a21f1252e` | 2026-08-06 | chore: drop the OpenHands/OpenHands bump-PR target from version-bump-prs.yml (#4400) | — | — | 0 | ignored/unmapped |
| `1fccbc71ba93` | 2026-08-07 | agent-server: make conversation worktree root configurable (#4362) | server | `config`, `conversation`, `init`, `test_conversation` | 4 | NO_TARGET_CHANGE |
| `e8daeed9cb0c` | 2026-08-06 | chore(deps): bump json-repair from 0.54.2 to 0.60.1 (#4346) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `e8daeed9cb0c` | 2026-08-06 | chore(deps): bump json-repair from 0.54.2 to 0.60.1 (#4346) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `ef9f5b09968f` | 2026-08-07 | feat: derive automation conversation tags in base RemoteWorkspace (#4414) | sdk | `test_cloud_workspace_automation_tags`, `workspace` | 3 | NO_TARGET_CHANGE |
| `0bf147a605f4` | 2026-08-07 | fix(observability): record non-executed tool results (#4415) | sdk | `agent`, `conversation`, `observability` | 6 | NO_TARGET_CHANGE |
| `dbb3c12de2a1` | 2026-08-07 | fix(acp): recover credential monitor after transient errors (#4403) | sdk | `agent` | 2 | DEVIATION |
| `c7e270aae43a` | 2026-08-07 | fix(sdk): make ACP auth failures self-diagnosing (#4404) | sdk | `agent` | 2 | DEVIATION |
| `be6cd3b80b70` | 2026-08-09 | fix(settings): inherit condenser max_tokens from LLM effective_max_input_tokens (#4435) | sdk | `settings`, `test_settings` | 2 | NO_TARGET_CHANGE |
| `684ea6a07041` | 2026-08-09 | fix(mcp): close reconciliation gaps left by #4367 (#4369) | sdk | `agent`, `conversation`, `mcp` | 9 | NO_TARGET_CHANGE |
| `684ea6a07041` | 2026-08-09 | fix(mcp): close reconciliation gaps left by #4367 (#4369) | server | `mcp_oauth_store`, `test_mcp_oauth_store` | 2 | NO_TARGET_CHANGE |
| `1fae5eb1fa58` | 2026-08-10 | chore(ci): collapse the auto-posted Agent Server images PR section (#4442) | — | — | 0 | ignored/unmapped |
| `fb5bbee05512` | 2026-08-10 | docs: encourage .pr/ HTML design doc + htmlpreview link for non-trivial PRs (#4371) | — | — | 0 | ignored/unmapped |
| `3e6a775c0044` | 2026-08-10 | fix(agent-server): initialize observability after deferred env (#4426) | server | `init`, `test_init` | 2 | NO_TARGET_CHANGE |
| `d2845a666574` | 2026-08-10 | docs: refresh AGENTS.md guidance (#4370) | sdk | `subagent` | 1 | NO_TARGET_CHANGE |
| `234e4cc79eda` | 2026-08-10 | refactor(plugin): extract PluginFormat strategy (prep for Agent Plugins support) (#4420) | sdk | `plugin` | 6 | EXCLUDED |
| `5f80ce0df703` | 2026-08-10 | fix(agent-server): compose ConversationInfo off the event loop to avoid GC wedge (#4417) | server | `conversation`, `test_conversation`, `test_remote_conversation_live_server` | 3 | NO_TARGET_CHANGE |
| `281843c78094` | 2026-08-10 | docs: refresh AGENTS.md guidance (#4449) | server | `AGENTS` | 1 | NO_TARGET_CHANGE |
| `6c3b687a1903` | 2026-08-11 | docs(examples): add runnable structured output example (#4418) | sdk | `56_structured_output` | 1 | NO_TARGET_CHANGE |
| `d66f10dc5a63` | 2026-08-11 | chore(deps): bump soupsieve from 2.8 to 2.8.4 (#4339) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `d66f10dc5a63` | 2026-08-11 | chore(deps): bump soupsieve from 2.8 to 2.8.4 (#4339) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `73cdfb7be545` | 2026-08-11 | feat: emit canonical conversation telemetry from agent server (#4459) | server | `README`, `conversation`, `telemetry` | 9 | NO_TARGET_CHANGE |
| `391fbb8d3c9c` | 2026-08-11 | Release v1.42.0 (#4466) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `391fbb8d3c9c` | 2026-08-11 | Release v1.42.0 (#4466) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `f09e03eac772` | 2026-08-11 | fix(goal): don't halt the goal loop on a STUCK run (#4381) | server | `event`, `test_goal_loop` | 2 | NO_TARGET_CHANGE |
| `5bfa7fc53986` | 2026-08-12 | feat(hooks): implement prompt-based evaluation (#4160) | sdk | `57_prompt_hooks`, `hooks`, `test_examples` | 8 | PORT |
| `9e340e58bc94` | 2026-08-12 | fix(llm): stop serializing calls through global config (#4473) | sdk | `llm` | 2 | NO_TARGET_CHANGE |
| `167c1f924ac8` | 2026-08-12 | Release v1.42.1 (#4475) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `167c1f924ac8` | 2026-08-12 | Release v1.42.1 (#4475) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `47b395d0eb7b` | 2026-08-12 | feat(plugin): add Agent Plugins manifest loader (root plugin.json, closed schema) (#4474) | sdk | `plugin`, `pyproject` | 7 | NO_TARGET_CHANGE |
| `effc01ef3352` | 2026-08-12 | fix(security-scan): improve release security scan comment (#4397) | — | — | 0 | ignored/unmapped |
| `f8a2f3ebb765` | 2026-08-13 | Add ready-for-dev issue and PR gates (#4464) | server | `test_check_issue_readiness`, `test_check_pr_description`, `test_refresh_linked_pr_checks` | 3 | NO_TARGET_CHANGE |
| `131b7523554b` | 2026-08-13 | perf(agent-server): cache unchanged conversation summaries (#4483) | server | `conversation`, `test_conversation` | 2 | NO_TARGET_CHANGE |
| `20f7f5f8f1e1` | 2026-08-13 | feat(file-router): add POST /file/create_directory (#4482) | server | `file`, `test_file` | 2 | NO_TARGET_CHANGE |
| `ceda00b478a4` | 2026-08-13 | fix(agent-server): move bash event search off event loop and replace glob with scandir (#4481) | server | `bash`, `test_bash` | 2 | NO_TARGET_CHANGE |
| `8a0117776351` | 2026-08-13 | test(terminal): stabilize Windows Ctrl-C cleanup assertion (#4290) | sdk | `terminal` | 1 | NO_TARGET_CHANGE |
| `c11602d122e2` | 2026-08-13 | fix(sdk): cap condenser token limit by agent context (#4461) | sdk | `context`, `test_settings` | 3 | NO_TARGET_CHANGE |
| `80646af66770` | 2026-08-13 | feat(llm): resolve provider-specific runtime metadata for routed models (#4423) | sdk | `agent`, `llm` | 8 | NO_TARGET_CHANGE |
| `2f7e8ed8216e` | 2026-08-14 | ci: re-run PR description check when new commits are pushed (#4486) | — | — | 0 | ignored/unmapped |
| `31f97e4ca80b` | 2026-08-15 | feat(security): AST-backed shell command-name resolution (#2721 Phase 2b) (#3944) | sdk | `security` | 6 | DEVIATION |
| `46ad3d43dc38` | 2026-08-14 | feat: add pre-flight LLM validation endpoint (POST /api/profiles/{name}/validate) (#4422) | server | `profiles`, `test_profiles` | 2 | NO_TARGET_CHANGE |
| `7a1b87f3d7e9` | 2026-08-14 | fix(profiles): repair v1 skills migration (#4320) | sdk | `persisted_settings_baselines`, `profiles` | 5 | DEVIATION |
| `7a1b87f3d7e9` | 2026-08-14 | fix(profiles): repair v1 skills migration (#4320) | server | `test_check_persisted_settings_compat` | 1 | NO_TARGET_CHANGE |
| `23ee276f1c68` | 2026-08-15 | feat: carry ConversationErrorEvent on ConversationRunError for automation callbacks (#4458) | sdk | `conversation`, `workspace` | 7 | NO_TARGET_CHANGE |
| `007721b3d2bf` | 2026-08-17 | fix: make dict-entry secret redaction case-insensitive (#4508) | sdk | `utils` | 2 | PORT |
| `b56221283f74` | 2026-08-16 | fix: redact API key from validate_profile error responses and logs (#4506) | server | `profiles`, `test_profiles` | 2 | NO_TARGET_CHANGE |
| `4e9940e96caa` | 2026-08-17 | fix(agent-server): base_state.json as single source of truth for the agent (end meta.json duplication) (#4440) | sdk | `conversation` | 4 | NO_TARGET_CHANGE |
| `4e9940e96caa` | 2026-08-17 | fix(agent-server): base_state.json as single source of truth for the agent (end meta.json duplication) (#4440) | server | `conversation`, `event`, `models`, `telemetry`, `test_agent_launch_additions`, `test_agent_profile_conv_start`, `test_auto_title_span_metadata`, `test_conversation`, `test_conversation_info_model`, `test_conversation_service_plugin`, `test_conversation_tags`, `test_credential_binding`, `test_event`, `test_event_streaming`, `test_goal_loop`, `test_switch_llm_survives_reload`, `test_webhook_subscriber` | 18 | NO_TARGET_CHANGE |
| `c3696580dad9` | 2026-08-17 | feat: add public from_persisted() entry point to AgentSettingsBase (#3503) | sdk | `settings`, `test_settings` | 2 | NO_TARGET_CHANGE |
| `98338ff37aea` | 2026-08-17 | chore(deps): bump mcp from 1.26.0 to 1.28.1 (#4347) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `98338ff37aea` | 2026-08-17 | chore(deps): bump mcp from 1.26.0 to 1.28.1 (#4347) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `9b38261a9d80` | 2026-08-18 | feat(sdk): add cleanup LLM profile for outward agent text (#4344) | sdk | `llm` | 3 | NO_TARGET_CHANGE |
| `d460d1a0b6bd` | 2026-08-18 | feat: Add deployment kind to agent-server telemetry (#4522) | server | `config`, `telemetry`, `telemetry_types`, `test_config` | 10 | NO_TARGET_CHANGE |
| `ae18d7cd0fbe` | 2026-08-18 | chore(deps-dev): bump pillow from 12.2.0 to 12.3.0 (#4518) | sdk | `dependencies`, `pyproject`, `repository` | 3 | NO_TARGET_CHANGE |
| `ae18d7cd0fbe` | 2026-08-18 | chore(deps-dev): bump pillow from 12.2.0 to 12.3.0 (#4518) | server | `dependencies`, `repository` | 2 | NO_TARGET_CHANGE |
| `8acbbb12dbc5` | 2026-08-18 | feat(telemetry): identify automation conversations (#4529) | server | `conversation`, `telemetry` | 4 | NO_TARGET_CHANGE |
| `ddf1cc2af979` | 2026-08-19 | Weekly test sweep: remove low-value tests + simplify (#4484) | sdk | `agent`, `browser_use`, `conversation`, `file_editor`, `llm`, `test_tool_name_consistency`, `tool` | 15 | NO_TARGET_CHANGE |
| `ddf1cc2af979` | 2026-08-19 | Weekly test sweep: remove low-value tests + simplify (#4484) | server | `telemetry` | 1 | NO_TARGET_CHANGE |
| `bb26768cc501` | 2026-08-19 | test(sdk): pin events_to_messages boundaries + fix responses_reasoning_item batch drop (#4526) | sdk | `event` | 2 | NO_TARGET_CHANGE |
| `73fabfd76491` | 2026-08-19 | Add read-at-use LLM provider connections (#4492) | sdk | `llm` | 5 | DEVIATION |
| `73fabfd76491` | 2026-08-19 | Add read-at-use LLM provider connections (#4492) | server | `_secrets_exposure`, `api`, `persistence`, `profiles`, `provider_connections`, `settings`, `test_profiles` | 8 | NO_TARGET_CHANGE |
| `d98fd95005fb` | 2026-08-19 | test(sdk): pin send_message skill-activation wiring (#4536) | sdk | `conversation` | 2 | NO_TARGET_CHANGE |
| `1de2e6d1bfcf` | 2026-08-20 | fix(agent-server): propagate out-of-band run failures as ConversationErrorEvent (#16686) (#4535) | sdk | `conversation` | 2 | NO_TARGET_CHANGE |
| `1de2e6d1bfcf` | 2026-08-20 | fix(agent-server): propagate out-of-band run failures as ConversationErrorEvent (#16686) (#4535) | server | `conversation`, `event`, `test_conversation`, `test_event` | 4 | NO_TARGET_CHANGE |
| `3e38fade8fe9` | 2026-08-21 | fix(sdk): normalize Kimi K3 vision metadata (#4567) | sdk | `llm` | 1 | NO_TARGET_CHANGE |
| `4c1237f391fe` | 2026-08-21 | Release v1.43.0 (#4553) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `4c1237f391fe` | 2026-08-21 | Release v1.43.0 (#4553) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `6899f00b0f35` | 2026-08-21 | chore(deps): bump gitpython from 3.1.50 to 3.1.58 (#4545) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `6899f00b0f35` | 2026-08-21 | chore(deps): bump gitpython from 3.1.50 to 3.1.58 (#4545) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `3fa2a00affc5` | 2026-08-21 | feat(prompt): mention local conversation history (#4527) | sdk | `context` | 28 | NO_TARGET_CHANGE |
| `013fba462798` | 2026-08-21 | fix(sdk): resolve workspace default from active LLM profile (#4497) | sdk | `workspace` | 2 | NO_TARGET_CHANGE |
| `013fba462798` | 2026-08-21 | fix(sdk): resolve workspace default from active LLM profile (#4497) | server | `test_remote_conversation_live_server` | 1 | NO_TARGET_CHANGE |
| `dc0c8428438d` | 2026-08-21 | fix(agent): keep terminal prefix aliases from doubling an existing executable (#4471) | sdk | `agent` | 2 | NO_TARGET_CHANGE |
| `41f14a8ac6ad` | 2026-08-21 | feat(tools): add structured task outcome preset (#4479) | sdk | `preset`, `test_preset_default`, `test_task_outcome` | 5 | NO_TARGET_CHANGE |
| `ddac55697c5d` | 2026-08-21 | Release v1.43.1 (#4572) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `ddac55697c5d` | 2026-08-21 | Release v1.43.1 (#4572) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |
| `88afa9af5706` | 2026-08-22 | fix(agent-server): keep crash recovery result on interrupted action branch (#4488) | server | `event`, `test_conversation_lease_behavior` | 2 | NO_TARGET_CHANGE |
| `611629e6999a` | 2026-08-22 | fix(workspace): honor explicit provider host when injecting git clone tokens (#4571) | sdk | `test_cloud_workspace_repos`, `workspace` | 2 | PORT |
| `9421149592da` | 2026-08-22 | fix(agent-server): replace global _lifecycle_lock with per-conversation locks (#4570) | sdk | `io` | 1 | NO_TARGET_CHANGE |
| `9421149592da` | 2026-08-22 | fix(agent-server): replace global _lifecycle_lock with per-conversation locks (#4570) | server | `conversation`, `test_conversation` | 2 | NO_TARGET_CHANGE |
| `c20709fb587f` | 2026-08-23 | docs: document SDK repository boundaries (#4587) | — | — | 0 | ignored/unmapped |
| `6d3881035982` | 2026-08-23 | fix(tools): unique user_data_dir per conversation to prevent SingletonLock collisions (#4602) | sdk | `browser_use` | 3 | NO_TARGET_CHANGE |
| `ba0e57a46113` | 2026-08-24 | chore(deps): bump pyasn1 from 0.6.3 to 0.6.4 (#4619) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `ba0e57a46113` | 2026-08-24 | chore(deps): bump pyasn1 from 0.6.3 to 0.6.4 (#4619) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `25cc8e56a4d0` | 2026-08-24 | chore(deps): bump httplib2 from 0.31.0 to 0.32.0 (#4620) | sdk | `dependencies` | 1 | NO_TARGET_CHANGE |
| `25cc8e56a4d0` | 2026-08-24 | chore(deps): bump httplib2 from 0.31.0 to 0.32.0 (#4620) | server | `dependencies` | 1 | NO_TARGET_CHANGE |
| `041078f26698` | 2026-08-25 | fix(sdk): bound AsyncExecutor.close() so it cannot hang forever (#4548) | sdk | `utils` | 2 | NO_TARGET_CHANGE |
| `750b14f8313d` | 2026-08-25 | docs: refresh AGENTS.md guidance (#4612) | — | — | 0 | ignored/unmapped |
| `2002f9804c77` | 2026-08-25 | feat: add manifest to installed canvas extension responses (#4611) | server | `api`, `canvas_extensions`, `test_canvas_extensions` | 6 | NO_TARGET_CHANGE |
| `910115b3eaf7` | 2026-08-25 | chore(ci): clarify issue readiness bot comment and reference templates (#4625) | — | — | 0 | ignored/unmapped |
| `760eea284550` | 2026-08-25 | Relax ready-for-dev heading check to accept h2 headings (#4632) | server | `test_check_issue_readiness` | 1 | NO_TARGET_CHANGE |
| `b3bf98e04649` | 2026-08-26 | fix(agent-server): detect all secret-bearing fields for the plaintext-save warning, not just llm.api_key (#4618) | server | `persistence`, `test_persistence_secret_detection` | 3 | NO_TARGET_CHANGE |
| `c007ed9454ed` | 2026-08-26 | docs: refresh AGENTS.md guidance (#4648) | — | — | 0 | ignored/unmapped |
| `90917f02ab23` | 2026-08-26 | fix: enable condenser for subscription LLMs via existing completion dispatch (#4517) | sdk | `context`, `conversation`, `llm`, `settings` | 6 | NO_TARGET_CHANGE |
| `6fce02687281` | 2026-08-27 | feat(sdk): add ask_oracle tool (#3673) | sdk | `58_ask_oracle_tool`, `__init__`, `ask_oracle`, `conversation`, `test_examples`, `tool` | 10 | NO_TARGET_CHANGE |
| `92323138a636` | 2026-08-27 | docs(examples): align Ask Oracle conventions (#4655) | sdk | `58_ask_oracle_tool` | 1 | NO_TARGET_CHANGE |
| `a5d6a06d5b5b` | 2026-08-27 | refactor(agent-server): share ACP provider payload as a parent-independent Docker layer (#4651) | server | `docker` | 1 | NO_TARGET_CHANGE |
| `322dec7d7774` | 2026-08-27 | Release v1.44.0 (#4684) | sdk | `dependencies`, `pyproject`, `workspace` | 4 | NO_TARGET_CHANGE |
| `322dec7d7774` | 2026-08-27 | Release v1.44.0 (#4684) | server | `dependencies`, `pyproject` | 2 | NO_TARGET_CHANGE |

## Explicitly ignored repository paths

- .agents/skills/custom-codereview-guide.md
- .github/ISSUE_TEMPLATE/bug_template.yml
- .github/ISSUE_TEMPLATE/feature_request.yml
- .github/PULL_REQUEST_TEMPLATE.md
- .github/agent-server-openapi-weak-schema-allowlist.json
- .github/scripts/check_approval_drift.py
- .github/scripts/check_dependency_diff.py
- .github/scripts/check_issue_readiness.py
- .github/scripts/check_persisted_settings_compat.py
- .github/scripts/check_pr_description.py
- .github/scripts/post-readiness-comment.mjs
- .github/scripts/refresh_linked_pr_checks.py
- .github/scripts/security_scan_common.py
- .github/workflows/README-RELEASE.md
- .github/workflows/assign-reviews.yml
- .github/workflows/issue-readiness-check.yml
- .github/workflows/pr-description-check.yml
- .github/workflows/prepare-release.yml
- .github/workflows/qa-changes-by-openhands.yml
- .github/workflows/qa-changes-evaluation.yml
- .github/workflows/release-binaries.yml
- .github/workflows/security-scan.yml
- .github/workflows/server.yml
- .github/workflows/version-bump-prs.yml
- .pr/gpt-5-nano-integration-results.md
- .pr/prompt-hooks-live-run.md
- .pr/repro-async-executor-close-hang.py
- AGENTS.md
- CONTRIBUTING.md
- DEVELOPMENT.md
- README.md

## Review summary

- **PORT:** 6
- **NO_TARGET_CHANGE:** 132
- **DEVIATION:** 8
- **EXCLUDED:** 1
- **DEFERRED:** 0
- **UNREVIEWED:** 0
