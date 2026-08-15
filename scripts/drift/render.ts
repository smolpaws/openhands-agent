import { unitId } from './inventory.js';
import type { DriftInventory, DriftReview } from './types.js';

export function renderMarkdown(inventory: DriftInventory, review?: DriftReview): string {
  const lines: string[] = [];
  lines.push('# OpenHands upstream drift');
  lines.push('');
  lines.push(`- **Repository:** \`${inventory.repository}\``);
  lines.push(`- **Pinned:** \`${inventory.from}\` (${inventory.fromAuthoredAt})`);
  lines.push(`- **Candidate:** \`${inventory.to}\` (${inventory.toAuthoredAt})`);
  lines.push(`- **Commits:** ${inventory.totalCommits} total; ${inventory.firstParentCommits} first-parent review units`);
  lines.push('');

  lines.push('## Scope summary');
  lines.push('');
  lines.push('| Target | Commit units | Files | Tests | Examples | Modules | Policy hints |');
  lines.push('|---|---:|---:|---:|---:|---|---|');
  for (const target of ['sdk', 'server'] as const) {
    const summary = inventory.summary.targets[target];
    lines.push(`| ${target} | ${summary.commitUnits} | ${summary.files} | ${summary.tests} | ${summary.examples} | ${join(summary.modules)} | ${join(summary.policyHints)} |`);
  }
  lines.push('');

  lines.push('## First-parent changes');
  lines.push('');
  if (inventory.commits.length === 0) {
    lines.push('No upstream drift.');
  } else {
    lines.push('| Commit | Date | Subject | Target | Modules | Files | Disposition |');
    lines.push('|---|---|---|---|---|---:|---|');
    for (const commit of inventory.commits) {
      const targets = (['sdk', 'server'] as const).filter((target) => commit.units[target] !== undefined);
      if (targets.length === 0) {
        lines.push(`| \`${short(commit.sha)}\` | ${commit.authoredAt.slice(0, 10)} | ${escapeCell(commit.subject)} | — | — | 0 | ignored/unmapped |`);
        continue;
      }
      for (const target of targets) {
        const unit = commit.units[target];
        if (unit === undefined) continue;
        const disposition = review?.items[unitId(commit.sha, target)]?.disposition ?? 'UNREVIEWED';
        lines.push(`| \`${short(commit.sha)}\` | ${commit.authoredAt.slice(0, 10)} | ${escapeCell(commit.subject)} | ${target} | ${join(unit.modules)} | ${unit.files.length} | ${disposition} |`);
      }
    }
  }
  lines.push('');

  addPathSection(lines, 'Unmapped paths', inventory.commits.flatMap((commit) => commit.unmappedPaths.map((path) => `\`${short(commit.sha)}\` ${path}`)));
  addPathSection(lines, 'Explicitly ignored repository paths', inventory.summary.ignoredPaths);

  if (review !== undefined) {
    lines.push('## Review summary');
    lines.push('');
    const counts = new Map<string, number>();
    for (const item of Object.values(review.items)) {
      const key = item.disposition ?? 'UNREVIEWED';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const key of ['PORT', 'NO_TARGET_CHANGE', 'DEVIATION', 'EXCLUDED', 'DEFERRED', 'UNREVIEWED']) {
      lines.push(`- **${key}:** ${counts.get(key) ?? 0}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function addPathSection(lines: string[], title: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  lines.push(`## ${title}`);
  lines.push('');
  for (const path of paths) lines.push(`- ${path}`);
  lines.push('');
}

function join(values: readonly string[]): string {
  return values.length === 0 ? '—' : values.map((value) => `\`${escapeCell(value)}\``).join(', ');
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
