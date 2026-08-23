import { describe, expect, it } from 'vitest';

import { AgentContext } from '../../context/index.js';
import { pathMatchesGlob, skillSchema } from '../index.js';

describe('pathMatchesGlob', () => {
  it('matches gitignore-style globs against POSIX paths', () => {
    expect(pathMatchesGlob('src/main.ts', 'src/**')).toBe(true);
    expect(pathMatchesGlob('src/a/b.ts', 'src/**')).toBe(true);
    expect(pathMatchesGlob('test.ts', 'src/**')).toBe(false);
    expect(pathMatchesGlob('src/main.ts', '*.ts')).toBe(true);
    expect(pathMatchesGlob('a/b/main.ts', '*.ts')).toBe(true);
    expect(pathMatchesGlob('main.java', '*.ts')).toBe(false);
    expect(pathMatchesGlob('main.ts', 'main.?s')).toBe(true);
    expect(pathMatchesGlob('', 'src/**')).toBe(false);
    expect(pathMatchesGlob('src/main.ts', '')).toBe(false);
  });
});

describe('path-triggered skills', () => {
  it('parses frontmatter paths into a PathTrigger and disables model invocation', () => {
    const skill = skillSchema.parse({
      name: 'repo-rule',
      content: 'Always use tabs.',
      trigger: { type: 'path', paths: ['src/**'] },
      disableModelInvocation: true,
    });

    expect(skill.trigger?.type).toBe('path');
    expect(skill.matchTrigger('src/main.ts')).toBeNull();
    expect(skill.matchPathTrigger('src/main.ts')).toBe('src/**');
    expect(skill.matchPathTrigger('docs/readme.md')).toBeNull();
  });

  it('renders path rules in the tool-use suffix and never in the skill catalog', () => {
    const rule = skillSchema.parse({
      name: 'src-rule',
      content: 'Follow the repo style.',
      trigger: { type: 'path', paths: ['src/**'] },
      disableModelInvocation: true,
    });

    const context = new AgentContext({ skills: [rule] });
    const suffix = context.getSystemMessageSuffix();
    // A path rule is never advertised in the skill catalog (only datetime/etc.).
    expect(suffix).not.toContain('src-rule');
    expect(suffix).not.toContain('Follow the repo style.');

    const toolUse = context.getToolUseSuffix('src/agent/agent.ts');
    expect(toolUse).not.toBeNull();
    // Upstream renders the rule content + matched glob, not the skill name.
    expect(toolUse!.content.text).toContain('src/**');
    expect(toolUse!.content.text).toContain('Follow the repo style.');
    expect(toolUse!.activatedRules).toEqual(['src-rule']);
  });

  it('dedupes already-injected path rules', () => {
    const rule = skillSchema.parse({
      name: 'src-rule',
      content: 'Follow the repo style.',
      trigger: { type: 'path', paths: ['src/**'] },
      disableModelInvocation: true,
    });

    const context = new AgentContext({ skills: [rule] });
    expect(context.getToolUseSuffix('src/a.ts')).not.toBeNull();
    expect(context.getToolUseSuffix('src/b.ts', ['src-rule'])).toBeNull();
  });

  it('applies disabled_skills as a drift-tolerant deny-list', () => {
    const keep = skillSchema.parse({ name: 'keep', content: 'Keep me.' });
    const drop = skillSchema.parse({ name: 'drop', content: 'Drop me.' });

    const context = new AgentContext({ skills: [keep, drop], disabledSkills: ['drop', 'absent-is-harmless'] });

    expect(context.skills.map((skill) => skill.name)).toEqual(['keep']);
  });
});