import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { textContent } from '../../llm/index.js';
import { AgentContext } from '../../context/index.js';
import { loadSkillsFromDir, mergeSkillsByName, Skill, skillSchema, skillsToPrompt } from '../index.js';

describe('Skill', () => {
  it('loads AgentSkills SKILL.md files with metadata, resources, and triggers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-skills-'));
    try {
      const skillDir = join(root, 'pdf-tools');
      await mkdir(join(skillDir, 'references'), { recursive: true });
      await writeFile(join(skillDir, 'references', 'usage.md'), '# Usage');
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: pdf-tools\ndescription: Extract PDFs safely\ntriggers:\n  - pdf\nallowed-tools: file_editor terminal\n---\n# PDF Tools\nUse pdftotext.\n`);

      const skill = await Skill.load(join(skillDir, 'SKILL.md'));

      expect(skill).toMatchObject({
        name: 'pdf-tools',
        description: 'Extract PDFs safely',
        isAgentskillsFormat: true,
        allowedTools: ['file_editor', 'terminal'],
        resources: { references: ['usage.md'] },
      });
      expect(skill.matchTrigger('please read this PDF')).toBe('pdf');
      expect(skill.getSkillType()).toBe('agentskills');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads legacy always-active and trigger skills from a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-skills-'));
    try {
      await writeFile(join(root, 'repo.md'), '# Repo rules\nAlways active.\n');
      await writeFile(join(root, 'debug.md'), `---\ntriggers:\n  - debug\n---\n# Debug\nUse logs.\n`);

      const loaded = await loadSkillsFromDir(root);

      expect(Object.keys(loaded.repoSkills)).toEqual(['repo']);
      expect(Object.keys(loaded.knowledgeSkills)).toEqual(['debug']);
      expect(loaded.knowledgeSkills.debug?.matchTrigger('debug this')).toBe('debug');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders available skills prompt with XML escaping and truncation notice', () => {
    const skill = skillSchema.parse({ name: 'web<&>', content: '# Title\nUse browser <carefully> and cite sources.', trigger: { type: 'keyword', keywords: ['web'] } });

    expect(skillsToPrompt([skill], 12)).toContain('&lt;&amp;&gt;');
    expect(skillsToPrompt([skill], 12)).toContain('characters truncated');
  });

  it('merges skills by name with primary precedence', () => {
    const primary = [skillSchema.parse({ name: 'same', content: 'primary' })];
    const secondary = [skillSchema.parse({ name: 'same', content: 'secondary' }), skillSchema.parse({ name: 'other', content: 'other' })];

    expect(mergeSkillsByName(primary, secondary).map((skill) => skill.content)).toEqual(['primary', 'other']);
  });
});

describe('AgentContext', () => {
  it('renders repo skills, available skills, datetime, secrets, and suffixes', () => {
    const context = new AgentContext({
      skills: [
        skillSchema.parse({ name: 'agents', content: 'Repo rule content.' }),
        skillSchema.parse({ name: 'debug', content: 'Debug content.', description: 'Debug help', trigger: { type: 'keyword', keywords: ['debug'] } }),
      ],
      systemMessageSuffix: 'System suffix.',
      userMessageSuffix: 'User suffix.',
      currentDatetime: '2026-06-24T00:00:00+02:00',
      secrets: { GITHUB_TOKEN: { description: 'GitHub token' } },
    });

    const system = context.getSystemMessageSuffix();
    expect(system).toContain('<REPO_CONTEXT>');
    expect(system).toContain('Repo rule content.');
    expect(system).toContain('<available_skills>');
    expect(system).toContain('GITHUB_TOKEN');
    expect(system).toContain('2026-06-24T00:00:00+02:00');

    const result = context.getUserMessageSuffix({ role: 'user', content: [textContent('please debug')], tool_calls: null, tool_call_id: null, name: null, reasoning_content: null, thinking_blocks: [], responses_reasoning_item: null }, []);
    expect(result?.content.text).toContain('Debug content.');
    expect(result?.content.text).toContain('User suffix.');
    expect(result?.activatedSkills).toEqual(['debug']);
  });
});
