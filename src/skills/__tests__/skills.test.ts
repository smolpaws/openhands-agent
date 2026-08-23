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

  it.each([
    // whole-word matches fire
    ['git', 'run git status', 'git'],
    ['git', 'git', 'git'],
    ['git', 'git status', 'git'],
    ['git', 'use git', 'git'],
    ['git', 'run git status twice, git', 'git'],
    // case-insensitive matching, original keyword returned
    ['git', 'GIT rocks', 'git'],
    ['git', 'use Git today', 'git'],
    ['GIT', 'run git status', 'GIT'],
    ['GitHub', 'open github now', 'GitHub'],
    // non-alnum boundaries fire
    ['git', 'git!', 'git'],
    ['git', 'git.', 'git'],
    ['git', '(git)', 'git'],
    ['git', 'git:status', 'git'],
    ['git', 'use-git-now', 'git'],
    ['git', 'my_git_repo', 'git'],
    ['git', 'line1\ngit\nline2', 'git'],
    // alphanumeric adjacency blocks (the #3643 false positives)
    ['git', 'check out github.com', null],
    ['git', 'the digit five', null],
    ['git', 'a legitimate reason', null],
    ['git', 'git2 branch', null],
    ['git', '2git branch', null],
    ['issue', 'hand me a tissue', null],
    // no match
    ['git', 'no match here', null],
    ['git', '', null],
    // slash-prefixed keywords (why alnum boundaries, not \b)
    ['/linear', 'use /linear now', '/linear'],
    ['/linear', '/linear', '/linear'],
    ['/linear', 'please /linear', '/linear'],
    ['/linear', 'run a linearization', null],
    ['/linear', 'src/linear.py', null],
    // multi-word phrases match as a unit
    ['pull request', 'open a pull request', 'pull request'],
    ['pull request', 'pull request!', 'pull request'],
    ['pull request', 'pullrequest', null],
    ['pull request', 'pull requests', null],
    // regex metacharacters stay literal
    ['c++', 'write c++ code', 'c++'],
    ['c++', 'c++today', null],
    ['a.b', 'call a.b now', 'a.b'],
    ['a.b', 'call axb now', null],
  ] as const)('matchTrigger whole-word for keyword %j against %j', (keyword, message, expected) => {
    const skill = skillSchema.parse({ name: 's', content: 'c', trigger: { type: 'keyword', keywords: [keyword] } });
    expect(skill.matchTrigger(message)).toBe(expected);
  });

  it('matchTrigger returns the first matching keyword in list order', () => {
    const skill = skillSchema.parse({ name: 's', content: 'c', trigger: { type: 'keyword', keywords: ['alpha', 'beta'] } });
    expect(skill.matchTrigger('beta then alpha')).toBe('alpha');
    expect(skill.matchTrigger('only beta here')).toBe('beta');
  });

  it('matchTrigger empties keyword never matches', () => {
    const skill = skillSchema.parse({ name: 's', content: 'c', trigger: { type: 'keyword', keywords: [''] } });
    expect(skill.matchTrigger('anything at all')).toBeNull();
    expect(skill.matchTrigger('')).toBeNull();
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

  it('renders dynamic suffix sections in the upstream registry order and strips custom_suffix', () => {
    const context = new AgentContext({
      skills: [
        skillSchema.parse({ name: 'repo', content: 'Repo rule content.' }),
        skillSchema.parse({ name: 'debug', content: 'Debug content.', description: 'Debug help', trigger: { type: 'keyword', keywords: ['debug'] } }),
      ],
      systemMessageSuffix: '  custom suffix text  ',
      currentDatetime: '2026-06-24T00:00:00+02:00',
      secrets: { GITHUB_TOKEN: { description: 'GitHub token' } },
    });

    const system = context.getSystemMessageSuffix();
    expect(system).not.toBeNull();

    // Upstream registry order: repo_context, available_skills, custom_suffix,
    // custom_secrets, datetime (datetime last — it is the volatile value).
    const datetimeIndex = system!.indexOf('<CURRENT_DATETIME>');
    const repoIndex = system!.indexOf('<REPO_CONTEXT>');
    const skillsIndex = system!.indexOf('<available_skills>');
    const customSuffixIndex = system!.indexOf('custom suffix text');
    const secretsIndex = system!.indexOf('<CUSTOM_SECRETS>');

    expect(datetimeIndex).toBeGreaterThanOrEqual(0);
    expect(repoIndex).toBeGreaterThanOrEqual(0);
    expect(skillsIndex).toBeGreaterThanOrEqual(0);
    expect(customSuffixIndex).toBeGreaterThanOrEqual(0);
    expect(secretsIndex).toBeGreaterThanOrEqual(0);

    expect(repoIndex).toBeLessThan(skillsIndex);
    expect(skillsIndex).toBeLessThan(customSuffixIndex);
    expect(customSuffixIndex).toBeLessThan(secretsIndex);
    expect(secretsIndex).toBeLessThan(datetimeIndex);

    // custom_suffix is stripped of surrounding whitespace.
    expect(system!.indexOf('  custom suffix text  ')).toBe(-1);
  });
});
