# Agent instructions

Before changing transpilation behavior:

1. Read `docs/TRANSPILE_CONTRACT.md`.
2. Read the current code and tests before trusting status notes or old architecture prose.
3. Work against a finite upstream interval `OLD_PIN..NEW_PIN`; never treat moving `HEAD` as the unit of work.
4. Classify upstream changes before coding: `PORT`, `NO_TARGET_CHANGE`, `DEVIATION`, `EXCLUDED`, or `DEFERRED`.
5. For `PORT`, port/adapt the relevant upstream test first and demonstrate red before implementation.
6. Do not introduce or widen an intentional difference without updating a stable `DEV-*` or `EXC-*` policy entry in the contract.
7. Prefer generated drift/source inventories and differential/golden evidence over hand-maintained parity lists.
8. Provider live smokes prove external API viability, not Python/TypeScript parity.
9. Do not move the upstream pin while an in-scope change is unclassified.
10. Beads/issues are work tracking only; they do not define compatibility.

Keep provider-specific behavior in provider clients. Keep the shared LLM boundary thin. Product/REST LLM configuration stays profile-first, and raw persistent secrets stay out of settings/profiles/events/logs.
