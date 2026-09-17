/** PORT: pinned summarizing_prompt.j2 and event __str__ previews. No event JSON or opaque reasoning is sent. */
import { toLLMMessage, type LLMConvertibleEvent } from '../event/index.js';
import { contentToString } from '../llm/index.js';
import { DEFAULT_TRUNCATE_NOTICE } from '../utils/index.js';

const PROMPT_HEAD = "You are maintaining a context-aware state summary for an interactive agent.\nYou will be given a list of events corresponding to actions taken by the agent, which will include previous summaries.\nIf the events being summarized contain ANY task-tracking, you MUST include a TASK_TRACKING section to maintain continuity.\nWhen referencing tasks make sure to preserve exact task IDs and statuses.\n\nTrack:\n\nUSER_CONTEXT: (Preserve essential user requirements, goals, and clarifications in concise form)\n\nTASK_TRACKING: {Active tasks, their IDs and statuses - PRESERVE TASK IDs}\n\nCOMPLETED: (Tasks completed so far, with brief results)\nPENDING: (Tasks that still need to be done)\nCURRENT_STATE: (Current variables, data structures, or relevant state)\n\nFor code-specific tasks, also include:\nCODE_STATE: {File paths, function signatures, data structures}\nTESTS: {Failing cases, error messages, outputs}\nCHANGES: {Code edits, variable updates}\nDEPS: {Dependencies, imports, external calls}\nVERSION_CONTROL_STATUS: {Repository state, current branch, PR status, commit history}\n\nPRIORITIZE:\n1. Adapt tracking format to match the actual task type\n2. Capture key user requirements and goals\n3. Distinguish between completed and pending tasks\n4. Keep all sections concise and relevant\n\nSKIP: Tracking irrelevant details for the current task type\n\nExample formats:\n\nFor code tasks:\nUSER_CONTEXT: Fix FITS card float representation issue\nCOMPLETED: Modified mod_float() in card.py, all tests passing\nPENDING: Create PR, update documentation\nCODE_STATE: mod_float() in card.py updated\nTESTS: test_format() passed\nCHANGES: str(val) replaces f\"{val:.16G}\"\nDEPS: None modified\nVERSION_CONTROL_STATUS: Branch: fix-float-precision, Latest commit: a1b2c3d\n\nFor other tasks:\nUSER_CONTEXT: Write 20 haikus based on coin flip results\nCOMPLETED: 15 haikus written for results [T,H,T,H,T,H,T,T,H,T,H,T,H,T,H]\nPENDING: 5 more haikus needed\nCURRENT_STATE: Last flip: Heads, Haiku count: 15/20\n\n";
const PROMPT_TAIL = "\n\nNow summarize the events using the rules above.";

export function renderSummarizingPrompt(eventStrings: readonly string[]): string {
  return PROMPT_HEAD + eventStrings.map(event => `\n<EVENT>\n${event}\n</EVENT>\n`).join('') + PROMPT_TAIL;
}

const characters = (value: string): string[] => [...value];
const preview = (value: string, length = 500): string => characters(value).length > 500 ? characters(value).slice(0, length).join('') + '...' : value;

export function renderCondenserEvent(event: LLMConvertibleEvent): string {
  const base = `${event.kind} (${event.source})`;
  switch (event.kind) {
    case 'SystemPromptEvent': {
      const text = event.system_prompt.type === 'text' ? event.system_prompt.text : '';
      const dynamic = event.dynamic_context?.type === 'text' ? `\n  Dynamic Context: ${characters(event.dynamic_context.text).length} chars` : '';
      return `${base}\n  System: ${preview(text)}\n  Tools: ${event.tools.length} available${dynamic}`;
    }
    case 'ActionEvent': {
      const thought = contentToString(event.thought).join(' ');
      if (event.action === null) return `${base}\n  Thought: ${preview(thought)}\n  Action: (not executed)\n  Call: ${event.tool_call.name}:${event.tool_call.id}`;
      // Python subclasses expose kind. Known native names preserve source acronym casing.
      // Custom host/MCP actions need kind for exact Python class-name parity; name-only fallback is a preview.
      const actionName = typeof event.action.kind === 'string' ? event.action.kind : event.tool_name === 'switch_llm' ? 'SwitchLLMAction' : `${event.tool_name.split('_').map(part => part[0]?.toUpperCase() + part.slice(1)).join('')}Action`;
      return `${base}\n  Thought: ${preview(thought)}\n  Action: ${actionName}`;
    }
    case 'ObservationEvent': {
      const content = typeof event.observation.text === 'string' ? event.observation.text : contentToString(toLLMMessage({ ...event, extended_content: [] }).content).join('');
      return `${base}\n  Tool: ${event.tool_name}\n  Result: ${preview(content)}`;
    }
    case 'UserRejectObservation': return `${base}\n  Tool: ${event.tool_name}\n  Reason: ${preview(event.rejection_reason)}`;
    case 'AgentErrorEvent': return `${base}\n  Error: ${preview(event.error)}`;
    case 'MessageEvent': {
      const message = toLLMMessage(event), parts = contentToString(message.content);
      if (!parts.length) return `${base}\n  ${message.role}: [no text content]`;
      const skills = event.activated_skills.length ? ` [Skills: ${event.activated_skills.join(', ')}]` : '';
      const thinking = event.llm_message.thinking_blocks.length ? ` [Thinking blocks: ${event.llm_message.thinking_blocks.length}]` : '';
      return `${base}\n  ${message.role}: ${preview(parts.join(' '), 497)}${skills}${thinking}`;
    }
    case 'CondensationSummaryEvent': return `${base}\n  user: ${preview(event.summary, 497)}`;
  }
}

/** Python str slicing counts Unicode code points, including while scaling hard-reset ceilings. */
export function truncateCondenserEvent(value: string, limit: number | null): string {
  const chars = characters(value);
  if (limit === null || limit <= 0 || chars.length <= limit) return value;
  const notice = characters(DEFAULT_TRUNCATE_NOTICE);
  if (notice.length >= limit) return notice.slice(0, limit).join('');
  const available = limit - notice.length, head = Math.ceil(available / 2), tail = Math.floor(available / 2);
  return chars.slice(0, head).join('') + DEFAULT_TRUNCATE_NOTICE + (tail > 0 ? chars.slice(-tail).join('') : '');
}
