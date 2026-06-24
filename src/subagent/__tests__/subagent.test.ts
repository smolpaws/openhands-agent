import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentDefinition,
  getAgentFactory,
  getFactoryInfo,
  getRegisteredAgentDefinitions,
  loadAgentsFromDir,
  loadProjectAgents,
  registerAgent,
  registerAgentIfAbsent,
  resetAgentRegistryForTests,
} from '../index.js';

describe('AgentDefinition', () => {
  it('loads frontmatter markdown and extracts examples and metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-agents-'));
    try {
      const file = join(root, 'reviewer.md');
      await writeFile(file, `---\nname: reviewer\ndescription: Review code. <example>Use for PRs</example>\ntools: TerminalTool\nskills: code, review\nmax_iteration_per_run: "5"\nmax_budget_per_run: "1.5"\ncustom: value\n---\nYou review code.\n`);

      const agent = await AgentDefinition.load(file);

      expect(agent).toMatchObject({ name: 'reviewer', tools: ['TerminalTool'], skills: ['code', 'review'], max_iteration_per_run: 5, max_budget_per_run: 1.5 });
      expect(agent.when_to_use_examples).toEqual(['Use for PRs']);
      expect(agent.metadata).toEqual({ custom: 'value' });
      expect(agent.system_prompt).toBe('You review code.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads project agents with .agents priority and deduplication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-project-agents-'));
    try {
      await mkdir(join(root, '.agents', 'agents'), { recursive: true });
      await mkdir(join(root, '.openhands', 'agents'), { recursive: true });
      await writeFile(join(root, '.agents', 'agents', 'same.md'), '---\nname: same\ndescription: primary\n---\nprimary');
      await writeFile(join(root, '.openhands', 'agents', 'same.md'), '---\nname: same\ndescription: legacy\n---\nlegacy');
      await writeFile(join(root, '.agents', 'agents', 'README.md'), '# skip');

      const agents = await loadProjectAgents(root);

      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ name: 'same', description: 'primary' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('subagent registry', () => {
  it('registers, deduplicates, lists, and resolves agent factories', () => {
    resetAgentRegistryForTests();
    const factory = () => ({ created: true });

    registerAgent('reviewer', factory, 'Reviews code');

    expect(registerAgentIfAbsent('reviewer', factory, 'Duplicate')).toBe(false);
    expect(getAgentFactory('reviewer').factoryFunc({})).toEqual({ created: true });
    expect(getFactoryInfo()).toContain('Reviews code');
    expect(getRegisteredAgentDefinitions()).toHaveLength(1);
    expect(() => registerAgent('reviewer', factory, 'Duplicate')).toThrow(/already registered/);
  });

  it('loads valid markdown files only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-load-agents-'));
    try {
      await writeFile(join(root, 'one.md'), '---\nname: one\n---\nOne');
      await writeFile(join(root, 'README.md'), '# ignored');
      await writeFile(join(root, 'note.txt'), 'ignored');

      expect(await loadAgentsFromDir(root)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
