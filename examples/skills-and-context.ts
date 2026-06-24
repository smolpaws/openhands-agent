import { AgentContext, Skill, messageSchema, textContent } from '@smolpaws/openhands-agent';

const repoGuidance = new Skill({
  name: 'repo-style',
  content: 'Keep changes small, typed, and easy to review.',
  trigger: null,
  source: 'examples/skills-and-context.ts',
  mcpTools: null,
  inputs: [],
  isAgentskillsFormat: false,
  version: '1.0.0',
  description: null,
  license: null,
  compatibility: null,
  metadata: null,
  allowedTools: null,
  disableModelInvocation: false,
  resources: null,
});

const testingSkill = new Skill({
  name: 'testing',
  content: 'When the user mentions tests, propose the smallest focused verification first.',
  trigger: { type: 'keyword', keywords: ['test', 'tests', 'verify'] },
  source: 'examples/skills-and-context.ts',
  mcpTools: null,
  inputs: [],
  isAgentskillsFormat: false,
  version: '1.0.0',
  description: 'Testing guidance',
  license: null,
  compatibility: null,
  metadata: null,
  allowedTools: null,
  disableModelInvocation: false,
  resources: null,
});

const context = new AgentContext({
  skills: [repoGuidance, testingSkill],
  systemMessageSuffix: 'Prefer clarity over cleverness.',
  currentDatetime: '2026-01-01T00:00:00.000Z',
});

const message = messageSchema.parse({ role: 'user', content: [textContent('Please add tests for this behavior.')] });
const suffix = context.getUserMessageSuffix(message);

console.log(context.getSystemMessageSuffix()?.includes('<REPO_CONTEXT>'));
console.log(suffix?.activatedSkills);
console.log(suffix?.content.text.includes('testing'));
