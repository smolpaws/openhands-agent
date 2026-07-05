import { RemoteWorkspace } from '@smolpaws/openhands-agent';

const host = process.env.OPENHANDS_AGENT_SERVER_URL;

if (!host) {
  console.log('Set OPENHANDS_AGENT_SERVER_URL to try RemoteWorkspace against an agent-server.');
  process.exit(0);
}

const workspace = new RemoteWorkspace({
  host,
  apiKey: process.env.OPENHANDS_AGENT_SERVER_API_KEY ?? null,
  workingDir: process.env.OPENHANDS_REMOTE_WORKING_DIR ?? 'workspace/project',
});

console.log('alive', await workspace.alive());
const result = await workspace.executeCommand('pwd && ls -la', { timeoutSeconds: 10 });
console.log({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
