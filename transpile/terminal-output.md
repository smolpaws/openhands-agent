# Terminal output clipping evidence

2026-10-04. Compatibility repair for `openhands-agent-g1f`, against the unchanged
canonical pin in [`upstream.json`](upstream.json). The missing cap was a port bug,
not an intentional expansion of DEV-SDK-006.

## Source and boundaries

Pinned Python sources:

- `openhands-tools/openhands/tools/terminal/constants.py`: `MAX_CMD_OUTPUT_SIZE = 30000`.
- `terminal/terminal_session.py`: clips command output before creating terminal observations.
- `definition.py`: `TerminalObservation.to_llm_content` formats prefix/suffix,
  working directory, interpreter and exit code, then clips that body separately.
  The error header is an additional text block outside that budget.
- `openhands-sdk/openhands/sdk/utils/truncate.py`: head/tail clipping with a
  notice, counting Unicode code points as Python strings do.

TypeScript caps combined stdout/stderr after command execution, including error
and timeout results, using the same 30,000-character budget. The existing 32 MiB
capture limit remains separate: lowering it to 30,000 bytes would kill commands
rather than clip their observations. Execution/session semantics remain governed
by DEV-SDK-006.

The event projection dispatches terminal results to a small renderer shared with
the executor's limit/metadata definitions. It accepts both legacy TypeScript
`text` and Python `content` arrays, uses available metadata, and does not mutate
persisted observations. The exec backend reports its known working directory and
exit code without inventing interpreter or persistent-session information.
Other tools retain their existing projection.

Pre-rendered `to_llm_content` arrays are an existing TypeScript host/replay
representation, not the pinned Python observation wire shape. Their explicit
rendering takes precedence over raw `text`/`content`. The terminal boundary caps
their combined textual body to 30,000 Unicode code points, preserving block order,
nontext content and surviving blocks' cache flags. Fully clipped middle text
blocks are omitted instead of becoming empty provider blocks.
An exact leading Python error-header block stays
outside that body budget. These arrays are already formatted: projection neither
adds metadata/error headers nor saves them again.

Optional `full_output_save_dir` uses the existing truncation helper's explicit
file-persistence path. No directory is selected by default. This saves the body
available at rendering time, which may already have been clipped by the executor;
it does not promise to retain original unbounded stdout. Historical oversized
observations remain intact on disk while their model-facing projection is bounded.

## Tests and oracle

`src/tools/__tests__/terminal-output.test.ts` adapts the pinned
`tests/tools/terminal/test_observation_truncation.py` cases (under, over and exact
limit; error header; prefix/suffix) and `test_terminal_session.py` clipping cases.
Additional regressions cover combined stdout/stderr, failures, timeouts, Unicode,
3.5-million-character restored output, Python-shaped content, event immutability,
non-terminal projection and explicitly requested file persistence.

2026-10-05 review follow-up: four new regressions first failed for pre-rendered
replay (100,000 characters passed through), a shared budget across text blocks,
Unicode with an existing error header and image, and explicit-content precedence.
They now pass; short pre-rendered mixed content remains unchanged.

The initial 13 cases failed before the repair: a restored 3.5-million-character
result serialized into 3,500,155 characters, and 100,000-character command results
were retained whole. They pass after applying the two clipping boundaries.

The generated [`wire/python-terminal-oracle.json`](wire/python-terminal-oracle.json)
records exact content hashes and Python character counts for nine cases. Generate
it with:

```sh
python3 scripts/parity/generate-python-terminal-oracle.py --upstream-repo ../agent-sdk
```

The generator reads the canonical pinned source with Git and executes the pure
`maybe_truncate` and `TerminalObservation.to_llm_content` functions extracted from
that source. A minimal text container replaces `TextContent`. This verifies exact
rendering/truncation, not Python model validation, subprocess sessions or file
persistence. The normal TypeScript test run checks every oracle case and pin.
