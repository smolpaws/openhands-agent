#!/usr/bin/env python3
"""Generate summary-prompt golden data using the manifest-pinned Python SDK.

Run with pinned packages on PYTHONPATH and installed Python SDK dependencies.
Only additive TS serialization adapters (excluded security metadata) are removed.
"""
from __future__ import annotations
import argparse
import inspect
import json
import subprocess
from pathlib import Path
from jinja2 import Environment
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.sdk.event import ActionEvent, AgentErrorEvent, CondensationSummaryEvent, MessageEvent, ObservationEvent, SystemPromptEvent, UserRejectObservation
from openhands.sdk.llm import ImageContent, Message, MessageToolCall, TextContent, ThinkingBlock
from openhands.sdk.mcp.definition import MCPToolAction, MCPToolObservation
from openhands.sdk.utils import maybe_truncate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    pin = json.loads((root / 'transpile/upstream.json').read_text())['commit']
    checkout = args.upstream.resolve()
    if subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip() != pin:
        raise ValueError('Checkout does not match manifest pin')
    if not Path(inspect.getfile(LLMSummarizingCondenser)).resolve().is_relative_to(checkout):
        raise ValueError('Condenser import does not belong to pinned checkout')
    call = MessageToolCall(id='call', name='test_tool', arguments='{}', origin='completion')
    events = [
        MessageEvent(source='user', llm_message=Message(role='user', content=[TextContent(text='User requirements')]), extended_content=[TextContent(text='Context extension')], activated_skills=['skill-one']),
        MessageEvent(source='agent', llm_message=Message(role='assistant', content=[TextContent(text='🙂' * 510)], thinking_blocks=[ThinkingBlock(thinking='private thinking', signature='opaque-signature')])),
        MessageEvent(source='agent', llm_message=Message(role='assistant', content=[])),
        MessageEvent(source='user', llm_message=Message(role='user', content=[ImageContent(image_urls=['https://example.com/image'])])),
        SystemPromptEvent(system_prompt=TextContent(text='System ' + 'x' * 510), dynamic_context=TextContent(text='🙂ab'), tools=[]),
        CondensationSummaryEvent(summary='Previous summary ' + 's' * 510),
        ActionEvent(thought=[TextContent(text='Think ' + 't' * 510)], action=MCPToolAction(data={}), tool_name='test_tool', tool_call_id='call', tool_call=call, llm_response_id='response'),
        ActionEvent(thought=[], action=None, tool_name='test_tool', tool_call_id='call', tool_call=call, llm_response_id='response'),
        ObservationEvent(observation=MCPToolObservation.from_text(text='Result ' + 'r' * 510, tool_name='test_tool'), extended_content=[TextContent(text='NOT IN DISPLAY')], action_id='action', tool_name='test_tool', tool_call_id='call'),
        UserRejectObservation(tool_name='test_tool', tool_call_id='call', action_id='action', rejection_reason='Rejected ' + 'e' * 510),
        AgentErrorEvent(tool_name='test_tool', tool_call_id='call', error='Error ' + 'e' * 510),
    ]
    cases=[]
    for i,event in enumerate(events):
        data=event.model_dump(mode='json', exclude_none=False)
        for key in ['security_risk', 'critic_result', 'summary']:
            if isinstance(event, ActionEvent): data.pop(key, None)
        data['id']=f'fixture-{i}'
        data['timestamp']='2026-01-01T00:00:00Z'
        cases.append({'name':f'{i}-{event.__class__.__name__}', 'event':data, 'text':str(event)})
    template=(checkout/'openhands-sdk/openhands/sdk/context/condenser/prompts/summarizing_prompt.j2').read_text()
    event_strings=[str(event) for event in events]
    prompt=Environment(autoescape=False).from_string(template).render(events=event_strings)
    truncation=[{'input':'🙂abcdef' * 80, 'limit':limit, 'text':maybe_truncate('🙂abcdef' * 80, truncate_after=limit)} for limit in [0,1,100,130,131,300]]
    args.output.write_text(json.dumps({'upstream_commit':pin,'cases':cases,'prompt':prompt,'truncation':truncation},indent=2,ensure_ascii=False)+'\n')
    print(f'Generated {len(cases)} prompt event cases and {len(truncation)} truncation cases')

if __name__=='__main__': main()
