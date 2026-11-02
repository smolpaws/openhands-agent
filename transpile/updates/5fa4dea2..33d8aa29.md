# Bounded upstream review

**From:** `5fa4dea24c52fe3ac53fa4e3e67a1376b72189e2`  
**To:** `33d8aa29c3078d074799e2fbf5e847aeb2d71360`

> Generated view. Edit semantic annotations in the JSON review record, then regenerate this page.

## Review units (60)

### `079d410db4fe17ccfe28b80f58b12676cf854c7c:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `07e6e059afd836817d8263d3edb67cb95d5c203e:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `0b51554da5baa94fbd0b7919eec6a610fdbe93ec:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `10b9b5a9242f548e6a38a7e9bfa7ddeb1795b976:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `1396fa7ff6510a28fe9587b1708376f23507cd5b:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `14f821bb2af5439bdcdb84193b470739e68d971f:sdk`

- **Target:** sdk
- **Disposition:** `PORT`
- **Reason:** list git changes of a repository subdirectory relative to it (src/git)

### `304ea67a7993c04c45a4d2caefa5a0ad228e9c61:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `33d8aa29c3078d074799e2fbf5e847aeb2d71360:sdk`

- **Target:** sdk
- **Disposition:** `PORT`
- **Reason:** Ported the v1.56.0 settings/profile migration tests-first: AGENT_PROFILE_SCHEMA_VERSION 3->4, AGENT_SETTINGS_SCHEMA_VERSION 8->9, removed deprecated tool-switch folding (enable_sub_agents/enable_switch_llm_tool now rejected on requests), and removed ACPAgentSettings.llm. The enable_browser system_prompt_kwargs removal has no TS counterpart (src/agent exposes no enable_browser kwarg).

### `33d8aa29c3078d074799e2fbf5e847aeb2d71360:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `3adf42f6377b570dfea53cc02bc669e1515f18f8:sdk`

- **Target:** sdk
- **Disposition:** `PORT`
- **Reason:** upstream routes meta-profile storage through Path(...).expanduser(). TS now expands bare ~ and ~/state, resolves named POSIX users through the account database instead of guessing sibling directories, and rejects unknown accounts. Regression tests exercise the real root account and an unknown account; Windows retains its sibling-home expansion.

### `3e8e17bee85494eb5ec2eae71ad0bb011e35b33d:sdk`

- **Target:** sdk
- **Disposition:** `NO_TARGET_CHANGE`
- **Reason:** Python-only dependency pin (openhands-sdk/pyproject.toml and uv.lock); no TypeScript counterpart

### `3e8e17bee85494eb5ec2eae71ad0bb011e35b33d:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `3f26a0570e96e92c6af0b75388e31c9bf4f23efc:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `3f3294581ebf40f3bbe5b96aec1d28b7fec96226:sdk`

- **Target:** sdk
- **Disposition:** `DEFERRED`
- **Reason:** upstream replays events missed during WebSocket reconnect to RemoteConversation callbacks exactly once (test_reconnect_replays_missed_events_to_callbacks_once). The TS RemoteConversation has no WebSocket transport, so reconnect replay/deduplication has no counterpart; REST history synchronization does not deliver those notifications. Not excluded by any policy.

### `478a6f9caebc42e3e2625f741ea73336a2551b90:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `47c50f7e5c6862822990065b6eee23718f5e650e:sdk`

- **Target:** sdk
- **Disposition:** `NO_TARGET_CHANGE`
- **Reason:** tmux_terminal.py socket-path fix; the TS port uses the exec-based terminal executor (DEV-SDK-006) and has no tmux socket path

### `47c50f7e5c6862822990065b6eee23718f5e650e:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `4a5f5a09096aea331b91481a5ff94dbfed22940e:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `501d27323cf36325242508de6fbf6a6a66c05b2b:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `57c71706e83c83b8f58a6b4efc959f5132cec94b:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `5966c781ed014efc96c028a99bddd4ff78426741:sdk`

- **Target:** sdk
- **Disposition:** `DEFERRED`
- **Reason:** new start_child_conversation tool surface; needs a design decision on whether to add a child-conversation tool to the TS port

### `5966c781ed014efc96c028a99bddd4ff78426741:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `59b2831c17fbd6793f1cb8103d3fd91e57420324:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `60c6f62133e0f649e2e71ec8c8aa51a06a1fb0f0:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `615759cc3497c8e4a8037a65c3f960da50156b65:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `6235a41b5b847296e9f8bece1479c060e9a14a5f:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `6530325e9dd0ea1b6b4f1994d7dab52764cfc3f1:sdk`

- **Target:** sdk
- **Disposition:** `NO_TARGET_CHANGE`
- **Reason:** marketplace registry change (load skills without a manifest) has no TS counterpart under EXC-SDK-002; the conversation file is a Python test-only adaptation with no src/ counterpart

### `6530325e9dd0ea1b6b4f1994d7dab52764cfc3f1:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `6ae64079cfd30cfe2f01a060c59168a4d650d883:sdk`

- **Target:** sdk
- **Disposition:** `PORT`
- **Reason:** redact_api_key_literals gains ghu_/ghs_/gho_ GitHub token prefixes, which also flows through upstream redact_text_secrets; the TS redactTextSecrets must redact the same literals. Ported the three prefixes and added regression coverage.

### `75abe1eb3f5fca908578d4437e8fee36125e4b0b:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `75dec1d3ef1cf1630502b31e83527e8e3301fb18:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `76055f697a5e9295252e0d54ab4ea822946e5c54:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `7a714f41db5cee3191735a4539a453755f6a5e7c:sdk`

- **Target:** sdk
- **Disposition:** `NO_TARGET_CHANGE`
- **Reason:** tests/conftest.py create_app test fixture only; no src/ surface to port

### `7a714f41db5cee3191735a4539a453755f6a5e7c:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `7abcd3bab78f988b2f2ca2485f4626a5484ce313:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `7d459bcb1111e42cb2e8059d26bc6354ca6cb510:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `7f41284acefd65a978c1075d7e19631a6730b782:sdk`

- **Target:** sdk
- **Disposition:** `DEVIATION`
- **Policy:** `DEV-SDK-005`
- **Policy hints:** `DEV-SDK-005`
- **Reason:** upstream guards a blank ACP model before the first run; the TS port has no ACP runtime (DEV-SDK-005)

### `804498a61126a90917efebb5c2c25defb53f2cf0:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `8869bcd914af1ef3fb588eeeab7c4b502b83a93e:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `8ba8ccbeb1a5306835f44f5f0f8ab20516373ee9:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `8d2c996de5bf4bc558c03451618124c49df24397:sdk`

- **Target:** sdk
- **Disposition:** `NO_TARGET_CHANGE`
- **Reason:** filters StreamingDeltaEvent frames out of RemoteEventsList; TS remote conversation is REST-polling only (state.events built from /events/search) and delivers no streamed deltas, so there is no streamed-delta path to filter

### `8ee5cba234d14f7841b52c3c8259a884a9179fdb:sdk`

- **Target:** sdk
- **Disposition:** `DEFERRED`
- **Reason:** both changed files (llm_profile_store.py and profile_refs.py) live under openhands-sdk/openhands/sdk/ and upstream adds the SDK test test_delete_llm_profile_blocked_through_json_alias, so this is SDK-owned reference-protection behavior, not an agent-server-only unit. It prevents deleting a referenced profile through its `.json` alias. The TS port has no LLMProfileStore/referrer scan, and missing store APIs do not establish an exclusion. The separate server delegation does not cover this SDK unit.

### `8ee5cba234d14f7841b52c3c8259a884a9179fdb:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `9af99982a1250b1b5d5095a5a49df4107fc18e14:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `9d07c6d55d1b371ed3d7ce6fba472ecef50f7a90:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `a6c7bf5591f64ca62c653565d7498d72e155e789:sdk`

- **Target:** sdk
- **Disposition:** `NO_TARGET_CHANGE`
- **Reason:** LocalConversation.switch_llm is registry-driven (llm_registry, create_subscription_llm_from_config, restore_metrics); the TS port has no llm_registry and no conversation-level switch_llm — switching is host-mediated through SwitchLLMTool.switchProfile — so there is no counterpart path to change.

### `a6c7bf5591f64ca62c653565d7498d72e155e789:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `acf55bcd26729d3f9212d5d5334047b6cd595d2a:sdk`

- **Target:** sdk
- **Disposition:** `DEFERRED`
- **Reason:** get_supported_llm_models now drops non-prefixed Bedrock-only ids via _is_litellm_bedrock_model; the offline getSupportedLLMModels filters only the bedrock prefix and needs a generated bedrock-provider id set plus a catalog regeneration under the pinned litellm environment.

### `af05c8b46a8a0a318f853e6297736fb883c8de73:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `b301ee008178ec4a357d3c2bc6370495c6ce1e3f:sdk`

- **Target:** sdk
- **Disposition:** `DEFERRED`
- **Reason:** upstream delivers streamed deltas to RemoteConversation token_callbacks and tests it with test_token_callbacks_receive_streamed_deltas. The TS RemoteConversation is REST-polling only and exposes no token-callback surface, so this observable behavior has no counterpart yet; REST history sync does not deliver those notifications. Not excluded by any policy.

### `bf9b6057b00e1b2b532ecff508c0d92d818adced:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `c73ec79e3fd1dfc1e5d6326fca4e0c14fa10029f:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `cab7bb4b29476cf4a70150f5f94ba97f22766b9a:sdk`

- **Target:** sdk
- **Disposition:** `DEFERRED`
- **Reason:** upstream rejects skill installs with unparsable frontmatter by wrapping Skill.load in a SkillValidationError and verifies no skill is installed (test_install_malformed_frontmatter_raises_validation_error). The TS Skill.load parses frontmatter at runtime and catalog loading invokes that parser, so the static-typing claim was inaccurate; but there is no install API surface to raise a validation error on, and no covering exclusion exists.

### `e5a1602e3bbc8b55571b7777bd6b6142101f11ad:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `e785defbf652f9c819d53d5ab8ea8eeb8332a942:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `e98b95654fdfe4001d605a6f61893d65d8fa0b3d:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `eac3ee16cc988ca4182f3f4e52b1dee67828cd12:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `f621dab57be854aaee3a982c83b6bf34b8ce5705:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `f676088d7a46f7bf6ab15f4b2d6551f8106cc30e:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

### `fd96074269cee08e8d8da917512b26b8d49c98f6:server`

- **Target:** server
- **Disposition:** `DELEGATED`
- **Reason:** openhands-agent-server is transpiled separately in smolpaws/smolpaws/packages/openhands-agent-server; the disposition is recorded in that package's server review record.

