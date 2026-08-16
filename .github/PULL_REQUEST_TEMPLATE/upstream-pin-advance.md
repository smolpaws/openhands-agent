# OpenHands upstream pin advance

## Interval

- **From:** `FULL_OLD_SHA`
- **To:** `FULL_NEW_SHA`
- **Reviewed interval record:** `transpile/updates/<interval>.json`
- **Readable generated view:** `transpile/updates/<interval>.md`

This PR must cover one immutable `OLD_PIN..NEW_PIN` interval. Do not replace either SHA with a moving branch name.

## Dispositions

Copy counts from the validated interval record:

- `PORT`:
- `NO_TARGET_CHANGE`:
- `DEVIATION`:
- `EXCLUDED`:
- `DEFERRED`:

Every `NO_TARGET_CHANGE` has a concrete reason. Every `DEVIATION`/`EXCLUDED` references a stable policy ID. Every `DEFERRED` has tracking, compatibility consequence, and revisit trigger.

## Tests-first evidence

For each `PORT` unit:

- [ ] Relevant upstream test/example was identified.
- [ ] The TypeScript test was added or adapted first.
- [ ] Red was observed for the expected reason.
- [ ] The smallest compatible implementation made it green.

## SDK evidence

- [ ] `npm test`
- [ ] `npm run test:drift`
- [ ] `npm run typecheck`
- [ ] `npm run typecheck:drift`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] SDK message/event/tool wire parity
- [ ] Affected examples

## Agent-server evidence

Link the coordinated `smolpaws/smolpaws` change:

- [ ] Vendored SDK manifest identifies `FULL_NEW_SHA`.
- [ ] Generated Python OpenAPI operation oracle identifies `FULL_NEW_SHA`.
- [ ] Generated semantic schema oracle identifies `FULL_NEW_SHA`.
- [ ] OpenAPI operation, transport, and schema reports are current.
- [ ] Deterministic server scenarios are current.
- [ ] Full agent-server package CI and cross-repository integration are green.

## Documentation impact

- [ ] Durable contracts changed only if policy changed.
- [ ] Architecture docs changed only if architecture changed.
- [ ] Historical/public pages received a status banner or follow-up when their claims became stale.
- [ ] No weekly drift counts, mutable parity totals, or release diary material were copied into durable policy docs.

## Closure

- [ ] `drift:check` passes for the interval.
- [ ] No target-relevant changed path is unclassified.
- [ ] SDK and server end on the same full upstream SHA.
- [ ] The canonical pin moves only in the closing change.
