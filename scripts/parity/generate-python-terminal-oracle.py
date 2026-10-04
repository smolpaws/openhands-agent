#!/usr/bin/env python3
"""Run pinned pure terminal rendering code without installing the Python runtime.

Only maybe_truncate and TerminalObservation.to_llm_content are extracted; model
validation, subprocess execution and file persistence are not oracle coverage.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream-repo", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]

    def source(path: str) -> ast.Module:
        return ast.parse(subprocess.check_output(
            ["git", "-C", args.upstream_repo, "show", f"{pin}:{path}"], text=True
        ))

    truncate = source("openhands-sdk/openhands/sdk/utils/truncate.py")
    constants = source("openhands-tools/openhands/tools/terminal/constants.py")
    definition = source("openhands-tools/openhands/tools/terminal/definition.py")
    scope = {"TextContent": SimpleNamespace}
    nodes = [node for node in truncate.body if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id in {"DEFAULT_TRUNCATE_NOTICE", "DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST"} for target in node.targets)]
    nodes += [node for node in truncate.body if isinstance(node, ast.FunctionDef) and node.name == "maybe_truncate"]
    nodes += [node for node in constants.body if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "MAX_CMD_OUTPUT_SIZE"]
    for cls in definition.body:
        if isinstance(cls, ast.ClassDef) and cls.name == "TerminalObservation":
            for method in cls.body:
                if isinstance(method, ast.FunctionDef) and method.name == "to_llm_content":
                    method.decorator_list = []
                    nodes.append(method)
    # Deferred annotations avoid importing SDK/pydantic/rich merely for type names.
    code = "from __future__ import annotations\n" + ast.unparse(ast.Module(body=nodes, type_ignores=[]))
    exec(compile(code, "pinned-terminal-renderer", "exec"), scope)
    metadata = dict(prefix="", suffix="", working_dir="/tmp", py_interpreter_path="/usr/bin/python", exit_code=0)
    trailing = "\n[Current working directory: /tmp]\n[Python interpreter: /usr/bin/python]\n[Command finished with exit code 0]"
    cases = [
        ("short", "Short output", 1, False, metadata),
        ("over-limit", "A", 31_000, False, metadata),
        ("error", "B", 30_500, True, {**metadata, "exit_code": 1}),
        ("exact-limit", "C", 30_000 - len(trailing), False, metadata),
        ("prefix-suffix", "D", 30_200, False, {**metadata, "prefix": "[PREFIX] ", "suffix": " [SUFFIX]"}),
        ("unicode", "🙂", 30_001, False, metadata),
        ("unicode-under-limit", "🙂", 20_000, False, metadata),
        ("multiline", "line\n", 15_000, False, metadata),
        ("timeout", "T", 100_000, True, {**metadata, "exit_code": -1, "suffix": "\nCommand timed out and was killed."}),
    ]
    results = []
    for name, text, repeat, is_error, meta in cases:
        observation = SimpleNamespace(text=text * repeat, is_error=is_error, metadata=SimpleNamespace(**meta), full_output_save_dir=None, ERROR_MESSAGE_HEADER="[An error occurred during execution.]\n")
        rendered = scope["to_llm_content"](observation)
        results.append(dict(id=name, text=text, repeat=repeat, is_error=is_error, metadata=meta, expected=[dict(characters=len(part.text), sha256=hashlib.sha256(part.text.encode()).hexdigest()) for part in rendered]))
    output = root / "transpile/wire/python-terminal-oracle.json"
    output.write_text(json.dumps(dict(source=dict(repository="OpenHands/software-agent-sdk", commit=pin), cases=results), ensure_ascii=False, indent=2) + "\n")
    print(f"Wrote {len(results)} pinned terminal rendering cases")


if __name__ == "__main__":
    main()
