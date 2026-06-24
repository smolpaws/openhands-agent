import { textContent, type Message, type TextContent } from '../llm/index.js';
import { skillsToPrompt, type Skill } from '../skills/index.js';

export interface SecretInfo {
  readonly name: string;
  readonly description?: string | null;
}

export interface AgentContextOptions {
  readonly skills?: readonly Skill[];
  readonly systemMessageSuffix?: string | null;
  readonly userMessageSuffix?: string | null;
  readonly secrets?: Readonly<Record<string, string | { readonly description?: string | null }>> | null;
  readonly currentDatetime?: Date | string | null;
}

export interface UserMessageSuffixResult {
  readonly content: TextContent;
  readonly activatedSkills: string[];
}

export class AgentContext {
  readonly skills: Skill[];
  readonly systemMessageSuffix: string | null;
  readonly userMessageSuffix: string | null;
  readonly secrets: Readonly<Record<string, string | { readonly description?: string | null }>> | null;
  readonly currentDatetime: Date | string | null;

  constructor(options: AgentContextOptions = {}) {
    this.skills = [...(options.skills ?? [])];
    assertUniqueSkillNames(this.skills);
    this.systemMessageSuffix = options.systemMessageSuffix ?? null;
    this.userMessageSuffix = options.userMessageSuffix ?? null;
    this.secrets = options.secrets ?? null;
    this.currentDatetime = options.currentDatetime ?? new Date();
  }

  getSecretInfos(additional: readonly SecretInfo[] = []): SecretInfo[] {
    const byName = new Map<string, SecretInfo>();
    if (this.secrets !== null) {
      for (const [name, value] of Object.entries(this.secrets)) {
        byName.set(name, { name, description: typeof value === 'object' ? value.description ?? null : null });
      }
    }
    for (const info of additional) {
      byName.set(info.name, info);
    }
    return [...byName.values()];
  }

  getFormattedDatetime(): string | null {
    if (this.currentDatetime === null) {
      return null;
    }
    return this.currentDatetime instanceof Date ? this.currentDatetime.toISOString() : this.currentDatetime;
  }

  partitionSkills(): { repoSkills: Skill[]; availableSkills: Skill[] } {
    const repoSkills: Skill[] = [];
    const availableSkills: Skill[] = [];
    for (const skill of this.skills) {
      if (skill.isAgentskillsFormat || skill.trigger !== null) {
        if (!skill.disableModelInvocation) {
          availableSkills.push(skill);
        }
      } else {
        repoSkills.push(skill);
      }
    }
    return { repoSkills, availableSkills };
  }

  getSystemMessageSuffix(additionalSecretInfos: readonly SecretInfo[] = []): string | null {
    const { repoSkills, availableSkills } = this.partitionSkills();
    const secretInfos = this.getSecretInfos(additionalSecretInfos);
    const datetime = this.getFormattedDatetime();
    const sections: string[] = [];

    if (repoSkills.length > 0) {
      sections.push(`<REPO_CONTEXT>\n${repoSkills.map((skill) => `[BEGIN context from [${skill.name}]]\n${skill.content.trim()}\n[END Context]`).join('\n\n')}\n</REPO_CONTEXT>`);
    }
    if (this.systemMessageSuffix !== null && this.systemMessageSuffix.trim().length > 0) {
      sections.push(this.systemMessageSuffix.trim());
    }
    if (availableSkills.length > 0) {
      sections.push(skillsToPrompt(availableSkills));
    }
    if (secretInfos.length > 0) {
      sections.push(`<CUSTOM_SECRETS>\n${secretInfos.map((secret) => `* **$${secret.name}**${secret.description ? ` - ${secret.description}` : ''}`).join('\n')}\n</CUSTOM_SECRETS>`);
    }
    if (datetime !== null) {
      sections.push(`<CURRENT_DATETIME>\n${datetime}\n</CURRENT_DATETIME>`);
    }

    return sections.length === 0 ? null : sections.join('\n\n');
  }

  getUserMessageSuffix(message: Message, skipSkillNames: readonly string[] = []): UserMessageSuffixResult | null {
    const suffix = this.userMessageSuffix?.trim() ?? '';
    const query = message.content.filter((content) => content.type === 'text').map((content) => content.text).join('\n').trim();
    const skip = new Set(skipSkillNames);
    const activated: Skill[] = [];
    const triggerBySkill = new Map<string, string>();

    if (query.length > 0) {
      for (const skill of this.skills) {
        const trigger = skill.matchTrigger(query);
        if (trigger !== null && !skip.has(skill.name)) {
          activated.push(skill);
          triggerBySkill.set(skill.name, trigger);
        }
      }
    }

    const parts: string[] = [];
    if (activated.length > 0) {
      parts.push(`<RECALLED_SKILLS>\n${activated.map((skill) => `<skill>\n<name>${skill.name}</name>\n<trigger>${triggerBySkill.get(skill.name) ?? ''}</trigger>\n<content>${skill.content}</content>\n${skill.source === null ? '' : `<location>${skill.source}</location>\n`}</skill>`).join('\n')}\n</RECALLED_SKILLS>`);
    }
    if (suffix.length > 0) {
      parts.push(suffix);
    }
    return parts.length === 0 ? null : { content: textContent(parts.join('\n\n')), activatedSkills: activated.map((skill) => skill.name) };
  }
}

function assertUniqueSkillNames(skills: readonly Skill[]): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate skill name found: ${skill.name}`);
    }
    seen.add(skill.name);
  }
}
