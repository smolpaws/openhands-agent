import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';

import { z } from 'zod';

export const keywordTriggerSchema = z.object({ type: z.literal('keyword').default('keyword'), keywords: z.array(z.string()) }).strict();
export const taskTriggerSchema = z.object({ type: z.literal('task').default('task'), triggers: z.array(z.string()) }).strict();
export const triggerSchema = z.discriminatedUnion('type', [keywordTriggerSchema, taskTriggerSchema]);
export const inputMetadataSchema = z.object({ name: z.string(), description: z.string() }).strict();
export const skillResourcesSchema = z.object({ skillRoot: z.string(), scripts: z.array(z.string()).default([]), references: z.array(z.string()).default([]), assets: z.array(z.string()).default([]) }).strict();

const skillDataSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  trigger: triggerSchema.nullable().default(null),
  source: z.string().nullable().default(null),
  mcpTools: z.record(z.string(), z.unknown()).nullable().default(null),
  inputs: z.array(inputMetadataSchema).default([]),
  isAgentskillsFormat: z.boolean().default(false),
  version: z.string().default('1.0.0'),
  description: z.string().nullable().default(null),
  license: z.string().nullable().default(null),
  compatibility: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.string()).nullable().default(null),
  allowedTools: z.array(z.string()).nullable().default(null),
  disableModelInvocation: z.boolean().default(false),
  resources: skillResourcesSchema.nullable().default(null),
}).strict();

export type KeywordTrigger = z.infer<typeof keywordTriggerSchema>;
export type TaskTrigger = z.infer<typeof taskTriggerSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type InputMetadata = z.infer<typeof inputMetadataSchema>;
export type SkillResources = z.infer<typeof skillResourcesSchema>;
export type SkillData = z.infer<typeof skillDataSchema>;
export type SkillType = 'repo' | 'knowledge' | 'agentskills';

export class Skill implements SkillData {
  readonly name: string;
  readonly content: string;
  readonly trigger: Trigger | null;
  readonly source: string | null;
  readonly mcpTools: Record<string, unknown> | null;
  readonly inputs: InputMetadata[];
  readonly isAgentskillsFormat: boolean;
  readonly version: string;
  readonly description: string | null;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: Record<string, string> | null;
  readonly allowedTools: string[] | null;
  readonly disableModelInvocation: boolean;
  readonly resources: SkillResources | null;

  constructor(data: SkillData) {
    this.name = data.name;
    this.content = data.content;
    this.trigger = data.trigger;
    this.source = data.source;
    this.mcpTools = data.mcpTools;
    this.inputs = data.inputs;
    this.isAgentskillsFormat = data.isAgentskillsFormat;
    this.version = data.version;
    this.description = data.description;
    this.license = data.license;
    this.compatibility = data.compatibility;
    this.metadata = data.metadata;
    this.allowedTools = data.allowedTools;
    this.disableModelInvocation = data.disableModelInvocation;
    this.resources = data.resources;
  }

  static async load(path: string, skillBaseDir?: string, strict = true): Promise<Skill> {
    const fileContent = await readFile(path, 'utf8');
    if (basename(path).toLowerCase() === 'skill.md') {
      return loadAgentSkill(path, fileContent, strict);
    }
    return loadLegacySkill(path, fileContent, skillBaseDir);
  }

  matchTrigger(message: string): string | null {
    if (this.trigger === null) {
      return null;
    }
    const messageLower = message.toLowerCase();
    const candidates = this.trigger.type === 'keyword' ? this.trigger.keywords : this.trigger.triggers;
    return candidates.find((candidate) => messageLower.includes(candidate.toLowerCase())) ?? null;
  }

  getTriggers(): string[] {
    if (this.trigger === null) {
      return [];
    }
    return this.trigger.type === 'keyword' ? [...this.trigger.keywords] : [...this.trigger.triggers];
  }

  getSkillType(): SkillType {
    if (this.isAgentskillsFormat) {
      return 'agentskills';
    }
    return this.trigger === null ? 'repo' : 'knowledge';
  }

  requiresUserInput(): boolean {
    return extractVariables(this.content).length > 0;
  }
}

export const skillSchema = skillDataSchema.transform((data) => new Skill(data));

export interface LoadedSkills {
  readonly repoSkills: Record<string, Skill>;
  readonly knowledgeSkills: Record<string, Skill>;
  readonly agentSkills: Record<string, Skill>;
}

export async function loadSkillsFromDir(skillDir: string): Promise<LoadedSkills> {
  const loaded: LoadedSkills = { repoSkills: {}, knowledgeSkills: {}, agentSkills: {} };
  if (!(await existsDirectory(skillDir))) {
    return loaded;
  }
  const entries = await readdir(skillDir, { withFileTypes: true });
  const skillMdDirectories = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = join(skillDir, entry.name, 'SKILL.md');
    if (await existsFile(skillPath)) {
      skillMdDirectories.add(entry.name);
      categorizeSkill(await Skill.load(skillPath, skillDir), loaded);
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') {
      continue;
    }
    if (skillMdDirectories.has(entry.name)) {
      continue;
    }
    categorizeSkill(await Skill.load(join(skillDir, entry.name), skillDir), loaded);
  }
  return loaded;
}

export function mergeSkillsByName(primary: readonly Skill[], secondary: readonly Skill[]): Skill[] {
  const merged = [...primary];
  const seen = new Set(merged.map((skill) => skill.name));
  for (const skill of secondary) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  return merged;
}

export function skillsToPrompt(skills: readonly Skill[], maxDescriptionLength = 1024): string {
  if (skills.length === 0) {
    return '<available_skills>\n  no available skills\n</available_skills>';
  }
  const lines = ['<available_skills>'];
  for (const skill of skills) {
    const { description, truncated } = skillDescription(skill, maxDescriptionLength);
    const suffix = truncated > 0 ? `... [${truncated} characters truncated. Call invoke_skill(name=${JSON.stringify(skill.name)}) to load the full skill]` : '';
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name.trim())}</name>`);
    lines.push(`    <description>${escapeXml(`${description}${suffix}`.trim())}</description>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

async function loadAgentSkill(path: string, fileContent: string, strict: boolean): Promise<Skill> {
  const parsed = parseFrontmatter(fileContent);
  const directoryName = basename(dirname(path));
  const name = stringValue(parsed.metadata.name) ?? directoryName;
  if (strict && !isValidAgentSkillName(name)) {
    throw new Error(`Invalid skill name '${name}'`);
  }
  const resources = await discoverSkillResources(dirname(path));
  return createSkillFromMetadata(name, parsed.content, path, parsed.metadata, resources, true);
}

function loadLegacySkill(path: string, fileContent: string, skillBaseDir?: string): Skill {
  const thirdPartyName = thirdPartySkillName(basename(path));
  if (thirdPartyName !== null) {
    return skillSchema.parse({ name: thirdPartyName, content: fileContent, source: path, trigger: null });
  }
  const parsed = parseFrontmatter(fileContent);
  const derivedName = skillBaseDir === undefined ? basename(path, extname(path)) : stripMarkdownExtension(relative(skillBaseDir, path));
  const name = stringValue(parsed.metadata.name) ?? derivedName;
  return createSkillFromMetadata(name, parsed.content, path, parsed.metadata, null, false);
}

function createSkillFromMetadata(name: string, content: string, source: string, metadata: Record<string, unknown>, resources: SkillResources | null, isAgentskillsFormat: boolean): Skill {
  const triggers = stringList(metadata.triggers);
  const inputs = inputList(metadata.inputs);
  const trigger = inputs.length > 0
    ? taskTriggerSchema.parse({ triggers: triggers.includes(`/${name}`) ? triggers : [...triggers, `/${name}`] })
    : triggers.length > 0
      ? keywordTriggerSchema.parse({ keywords: triggers })
      : null;
  const allowedRaw = metadata['allowed-tools'] ?? metadata.allowed_tools;
  return skillSchema.parse({
    name,
    content: appendMissingVariablesPrompt(content, trigger, inputs),
    source,
    trigger,
    inputs,
    isAgentskillsFormat,
    description: stringValue(metadata.description),
    license: stringValue(metadata.license),
    compatibility: stringValue(metadata.compatibility),
    metadata: metadataRecord(metadata.metadata),
    allowedTools: allowedTools(allowedRaw),
    disableModelInvocation: booleanValue(metadata['disable-model-invocation'] ?? metadata.disable_model_invocation) ?? false,
    resources,
  });
}

function parseFrontmatter(content: string): { metadata: Record<string, unknown>; content: string } {
  const lines = content.replaceAll(String.fromCharCode(13), '').split(String.fromCharCode(10));
  if (lines[0] !== '---') {
    return { metadata: {}, content };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    return { metadata: {}, content };
  }
  return { metadata: parseYamlSubset(lines.slice(1, end)), content: lines.slice(end + 1).join(String.fromCharCode(10)) };
}

function parseYamlSubset(lines: readonly string[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && currentListKey !== null) {
      const current = metadata[currentListKey];
      if (Array.isArray(current)) {
        current.push(trimmed.slice(2).trim());
      }
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw.length === 0) {
      metadata[key] = [];
      currentListKey = key;
    } else {
      metadata[key] = parseScalarOrInlineList(raw);
      currentListKey = null;
    }
  }
  return metadata;
}

function parseScalarOrInlineList(raw: string): unknown {
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0);
  }
  return stripQuotes(raw);
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function discoverSkillResources(skillRoot: string): Promise<SkillResources | null> {
  const resources: SkillResources = { skillRoot, scripts: [], references: [], assets: [] };
  for (const name of ['scripts', 'references', 'assets'] as const) {
    const directory = join(skillRoot, name);
    if (await existsDirectory(directory)) {
      resources[name] = await listFiles(directory);
    }
  }
  return resources.scripts.length > 0 || resources.references.length > 0 || resources.assets.length > 0 ? resources : null;
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function categorizeSkill(skill: Skill, loaded: LoadedSkills): void {
  if (skill.isAgentskillsFormat) {
    loaded.agentSkills[skill.name] = skill;
  } else if (skill.trigger === null) {
    loaded.repoSkills[skill.name] = skill;
  } else {
    loaded.knowledgeSkills[skill.name] = skill;
  }
}

function skillDescription(skill: Skill, maxLength: number): { description: string; truncated: number } {
  let description = skill.description ?? '';
  let truncated = 0;
  if (description.length === 0) {
    const lines = skill.content.replaceAll(String.fromCharCode(13), '').split(String.fromCharCode(10));
    let offset = 0;
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped.length === 0 || stripped.startsWith('#')) {
        offset += line.length + 1;
        continue;
      }
      description = stripped;
      truncated = Math.max(0, skill.content.length - offset - line.length);
      break;
    }
  }
  if (description.length > maxLength) {
    truncated += description.length - maxLength;
    description = description.slice(0, maxLength);
  }
  return { description, truncated };
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function extractVariables(content: string): string[] {
  const names: string[] = [];
  let index = 0;
  while (index < content.length) {
    const start = content.indexOf('${', index);
    if (start === -1) {
      return names;
    }
    const end = content.indexOf('}', start + 2);
    if (end === -1) {
      return names;
    }
    const name = content.slice(start + 2, end);
    if (name.length > 0) {
      names.push(name);
    }
    index = end + 1;
  }
  return names;
}

function appendMissingVariablesPrompt(content: string, trigger: Trigger | null, inputs: readonly InputMetadata[]): string {
  if (trigger?.type !== 'task' || (extractVariables(content).length === 0 && inputs.length === 0)) {
    return content;
  }
  const prompt = "\n\nIf the user didn't provide any of these variables, ask the user to provide them first before the agent can proceed with the task.";
  return content.includes(prompt) ? content : `${content}${prompt}`;
}

function stripMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith('.md') ? path.slice(0, -3) : path;
}

function thirdPartySkillName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === 'agents.md' || lower === 'agent.md') {
    return 'agents';
  }
  if (lower === '.cursorrules') {
    return 'cursorrules';
  }
  if (lower === 'claude.md') {
    return 'claude';
  }
  if (lower === 'gemini.md') {
    return 'gemini';
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item));
}

function inputList(value: unknown): InputMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => inputMetadataSchema.parse(item));
}

function metadataRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, String(nested)]));
}

function allowedTools(value: unknown): string[] | null {
  if (typeof value === 'string') {
    return value.split(' ').filter((part) => part.length > 0);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return null;
}

function isValidAgentSkillName(name: string): boolean {
  if (name.length === 0 || name.length > 64 || name.startsWith('-') || name.endsWith('-') || name.includes('--')) {
    return false;
  }
  for (const character of name) {
    const code = character.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isLower && !isDigit && character !== '-') {
      return false;
    }
  }
  return true;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function existsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}








