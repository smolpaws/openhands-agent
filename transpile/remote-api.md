# Remote API follow-up evidence

2026-10-04: follow-up to PR #53's September 29 review. The canonical upstream pin remains `d128a786ee2ee570eb23ff5862ec148b43cfad0b` (v1.49.2). This corrects the earlier `e2889cd4` remote API port; it does not advance the pin or change any other oracle.

## Creation and profile selection

`RemoteConversation.create()` requires an explicit `LocalWorkspace` payload and profile selection. The default `server: 'smolpaws'` serializes validated TypeScript `AgentSettings` as `agent`, including `llm_profile_ref`; it rejects a Python `agentProfileId`. The TS server validates that reference and rejects missing profiles. `server: 'python'` serializes a saved Python Agent Profile UUID as `agent_profile_id`; it rejects TypeScript settings, which are not compatible with Python settings. Python concrete-agent/raw-LLM creation is outside the profile-first target boundary (DEV-SDK-004).

Creation carries worktree, parent ID, initial message, iteration limit, stuck detection, hook configuration, launch additions, tags, user ID, observability, and title configuration. Persistence directory is a TS server option. Serialization of a configuration field does not establish that every host implements its execution semantics; in particular, this is not a new TS server hook-execution port. Plugins/security/confirmation and Python tool-module import machinery are not added by this client fix.

Create/attach reject invalid returned UUIDs and missing/unknown execution statuses before modifying supplied state. Attachment normalizes its request ID and never falls back to creation. Legacy direct construction remains a handle-only operation.

## Evidence

- Fourteen regression cases failed on the merged PR #53 implementation before the fix. They cover Python creation configuration, the TS `agent` mapping, incompatible/missing selection, malformed responses and accepted UUID representations.
- `scripts/parity/generate-python-remote-contract.py` verifies the checkout against the canonical manifest, loads the actual pinned `StartConversationRequest`, validates the creation payload, and records Pydantic UUID canonicalization and six invalid inputs. `src/conversation/__fixtures__/python-remote-contract.json` is the resulting bounded fixture. Normal SDK tests compare the client payload with that validated payload and bind it to the canonical pin.
- `scripts/parity/check-remote-profile-integration.ts` checks a real isolated TS server: selected `requested-profile` survives creation; attachment restores identity/status; a missing profile rejects. The probe uses in-memory secrets and a deterministic TestLLM; no provider calls. Run it with `node --import tsx scripts/parity/check-remote-profile-integration.ts <server-package>` against a server package consuming the current SDK build.
- The resident server's older vendored SDK supports settings version 5, while this SDK uses version 6. The successful probe used a temporary server source copy consuming this SDK build. Adoption requires coordinated re-vendoring; no resident process, service or source checkout was changed.

The Python evidence validates schema/configuration and UUID semantics. It does not run a Python conversation service or claim complete remote runtime parity.

To regenerate the fixture, use the Python environment with the pinned SDK dependencies, and a clean checkout at the manifest commit:

```sh
python scripts/parity/generate-python-remote-contract.py /path/to/pinned/software-agent-sdk
```
