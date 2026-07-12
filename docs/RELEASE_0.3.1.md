# Release 0.3.1

`0.3.1` is the async persistence patch release for `@smolpaws/openhands-agent`. It follows `0.3.0` by closing the post-release Bead `openhands-agent-bbh`: local persistence now has a non-blocking lock path for async runtime/server flows while keeping the synchronous compatibility API intact.

## Highlights

- Added non-blocking FileStore locking:
  - `FileStore.lockAsync()`
  - `LocalFileStore.lockAsync()` with promise-based lock-file acquisition, async polling, stale-lock cleanup, and release in `finally`
  - `InMemoryFileStore.lockAsync()` that holds an in-memory lock across awaited callbacks
- Preserved synchronous lock compatibility:
  - `FileStore.lock()` remains available for local/parity-oriented synchronous writes
  - synchronous locks still reject async callbacks/results
  - docs now steer hot server/runtime paths toward `lockAsync()`
- Added async event persistence APIs:
  - `EventLog.appendAsync()`
  - `EventLog.appendMultipleAsync()`
  - `ConversationState.appendEventAsync()`
  - `ConversationState.appendEventsAsync()`
  - `LocalConversation.sendMessageAsync()`
- Migrated async runtime append paths:
  - response dispatch now persists tool actions and observations via async/bulk state appends
  - max-iteration conversation errors persist through the async append path
- Hardened async lock cleanup:
  - callback errors are not shadowed by lock-file cleanup failures
  - async stale-lock checks treat transient lock-file access errors as active locks
- Closed Bead `openhands-agent-bbh`.

## Verification

Run before publishing/tagging:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```

Verification result for the release commit:

- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm test` — passed, 38 files / 236 tests
- `npm run build` — passed
- `npm run typecheck:examples` — passed
- `npm run test:examples` — passed
- `npm pack --dry-run` — passed

## Upgrade notes from 0.3.0

- Package metadata moves to `0.3.1`.
- Prefer `lockAsync()` and async append APIs on runtime/server paths that may experience FileStore lock contention.
- Existing synchronous `lock()`, `EventLog.append()`, `ConversationState.appendEvent()`, and `LocalConversation.sendMessage()` compatibility paths remain available.
