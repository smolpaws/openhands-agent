import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileEditorTool, GlobTool, GrepTool, TaskTrackerTool, TerminalTool } from '@smolpaws/openhands-agent';

const workspace = await mkdtemp(join(tmpdir(), 'openhands-agent-example-'));
try {
  const terminal = TerminalTool.create({ workingDir: workspace });
  const editor = FileEditorTool.create({ workspaceRoot: workspace });
  const glob = GlobTool.create({ workingDir: workspace });
  const grep = GrepTool.create({ workingDir: workspace });
  const tasks = TaskTrackerTool.create({ saveDir: workspace });

  await editor.execute({ command: 'create', path: join(workspace, 'src', 'hello.ts'), file_text: 'export const hello = "world";\n' });
  console.log(await terminal.execute({ command: 'find . -type f | sort' }));
  console.log(await glob.execute({ pattern: '*.ts' }));
  console.log(await grep.execute({ pattern: 'hello', include: '*.ts' }));
  await tasks.execute({ command: 'plan', task_list: [{ title: 'Try concrete tools', status: 'done' }] });
  console.log(await readFile(join(workspace, 'TASKS.md'), 'utf8'));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
