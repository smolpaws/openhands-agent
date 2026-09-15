"""Run pinned Python's pure subscription transform as a deterministic TS test oracle."""
import ast
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
pin = json.loads((root / "transpile/upstream.json").read_text())["commit"]
source = subprocess.check_output(["git", "-C", sys.argv[1], "show", f"{pin}:openhands-sdk/openhands/sdk/llm/auth/openai.py"], text=True)
module = ast.parse(source)
module.body = [node for node in module.body if (
    isinstance(node, ast.FunctionDef) and node.name in {"inject_system_prefix", "transform_for_subscription"}
) or (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "DEFAULT_SYSTEM_MESSAGE" for target in node.targets))]
namespace = {}
exec(compile(module, "pinned_openai_auth.py", "exec"), namespace)
cases = [
    {"system": ["one", "two"], "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}, {"type": "function_call_output", "call_id": "c", "output": "done"}]},
    {"system": ["system"], "input": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hello"}]}]},
    {"system": [], "input": [{"type": "message", "role": "user", "content": None}]},
]
for case in cases:
    case["expected"] = namespace["transform_for_subscription"](case["system"], json.loads(json.dumps(case["input"])))
(root / "src/llm/__tests__/fixtures/subscription-transform.json").write_text(json.dumps({"upstream": pin, "cases": cases}, indent=2) + "\n")
