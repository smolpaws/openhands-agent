"""Regenerate the TS catalog from the canonical pinned checkout: script /path/to/python-sdk."""
import ast
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
source = subprocess.check_output(["git", "-C", sys.argv[1], "show", f"{pin}:openhands-sdk/openhands/sdk/llm/utils/verified_models.py"], text=True)
values = {}
for statement in ast.parse(source).body:
    if isinstance(statement, ast.Assign):
        node = statement.value
        values[statement.targets[0].id] = (
            {ast.literal_eval(key): values[value.id] for key, value in zip(node.keys, node.values)}
            if isinstance(node, ast.Dict) else ast.literal_eval(node)
        )
output = "// Generated from pinned Python llm/utils/verified_models.py; run scripts/parity/generate-verified-models.py.\n"
for name, value in values.items():
    output += f"export const {name} = {json.dumps(value, indent=2)} as const;\n\n"
(root / "src/llm/verified-models.ts").write_text(output)
