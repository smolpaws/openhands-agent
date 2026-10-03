"""Generate bounded request/UUID evidence using the canonical pinned SDK checkout."""
import json
import copy
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID

repo = Path(__file__).resolve().parents[2]
upstream = Path(sys.argv[1]).resolve()
manifest = json.loads((repo / 'transpile/upstream.json').read_text())
actual = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip()
if actual != manifest['commit']:
    raise SystemExit('Upstream checkout does not match canonical pin')
for package in ('openhands-sdk', 'openhands-tools', 'openhands-workspace'):
    sys.path.insert(0, str(upstream / package))
os.environ['OPENHANDS_SUPPRESS_BANNER'] = '1'
from pydantic import TypeAdapter
from openhands.sdk.conversation.request import StartConversationRequest

identifier = '12345678-1234-1234-1234-123456789abc'
payload = {
    'workspace': {'kind': 'LocalWorkspace', 'working_dir': '/workspace'},
    'agent_profile_id': identifier, 'conversation_id': identifier, 'max_iterations': 17,
    'stuck_detection': False, 'hook_config': {'stop': [{'hooks': [{'command': 'true'}]}]},
    'tags': {'automationrun': 'run-one'}, 'observability_metadata': {'run': 'one'},
    'observability_tags': ['automation'], 'observability_span_name': 'scheduled-task',
    'user_id': 'operator', 'worktree': False,
    'initial_message': {'role': 'user', 'content': [], 'run': False},
    'autotitle': False, 'title_llm_profile': 'titles',
    'agent_launch_additions': {'system_message_suffix_append': 'context'},
}
validated = StartConversationRequest.model_validate(copy.deepcopy(payload))
assert str(validated.agent_profile_id) == identifier
assert validated.stuck_detection is False
assert validated.hook_config.stop[0].hooks[0].command == 'true'
uuids = []
for value in (identifier.upper(), identifier.replace('-', ''), '{' + identifier + '}', 'urn:uuid:' + identifier):
    uuids.append({'input': value, 'canonical': str(TypeAdapter(UUID).validate_python(value))})
invalid_uuids = ['', 'not-a-uuid', ' ' + identifier, identifier + ' ', identifier.replace('-', '')[:10] + '-' + identifier.replace('-', '')[10:], '{' + identifier]
for value in invalid_uuids:
    try:
        TypeAdapter(UUID).validate_python(value)
    except ValueError:
        pass
    else:
        raise AssertionError('Expected pinned validation to reject ' + repr(value))
output = {'upstreamCommit': actual, 'validatedCreatePayload': payload, 'uuids': uuids, 'invalidUuids': invalid_uuids}
(repo / 'src/conversation/__fixtures__/python-remote-contract.json').write_text(json.dumps(output, indent=2) + '\n')
print('Validated creation request and four UUID forms at ' + actual)
