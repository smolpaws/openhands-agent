# Agent instructions

Before changing transpilation behavior:

1. Read `docs/TRANSPILE_CONTRACT.md`.
2. When touching the upstream pin, drift reports, or parity tooling, also read `docs/DRIFT_TOOLING.md`.
3. Read current code and tests before trusting status notes or old architecture prose.
4. Work against a finite upstream interval `OLD_PIN..NEW_PIN`; never treat moving `HEAD` as the unit of work.
5. Classify upstream changes before coding: `PORT`, `NO_TARGET_CHANGE`, `DEVIATION`, `EXCLUDED`, or `DEFERRED`.
6. For `PORT`, port/adapt the relevant upstream test first and demonstrate red before implementation.
7. Do not introduce or widen an intentional difference without updating a stable `DEV-*` or `EXC-*` policy entry in the contract.
8. Prefer generated drift/source inventories and differential/golden evidence over hand-maintained parity lists.
9. Provider live smokes prove external API viability, not Python/TypeScript parity.
10. Do not move the upstream pin while an in-scope change is unclassified.
11. Beads/issues are work tracking only; they do not define compatibility.

Keep provider-specific behavior in provider clients. Keep the shared LLM boundary thin. Product/REST LLM configuration stays profile-first, and raw persistent secrets stay out of settings/profiles/events/logs.
