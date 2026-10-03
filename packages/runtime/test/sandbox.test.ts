import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DockerCodingSandbox, DockerSandboxError, createDockerCodingSandboxFromEnv, type DockerExecFile } from '../src/sandbox.js';

test('Docker Coding sandbox uses a fixed, network-disabled container contract', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-');
  try {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile: DockerExecFile = async (file, args) => { calls.push({ file, args }); return { stdout: 'ok', stderr: '' }; };
    const sandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile });
    await sandbox.run('pnpm', ['test'], root);
    await sandbox.writeFile(`${root}/src/example.txt`, 'safe content');

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.file, 'docker');
    assert.ok(calls[0]?.args.includes('--network=none'));
    assert.ok(calls[0]?.args.includes('--cap-drop=ALL'));
    assert.ok(calls[0]?.args.includes('--security-opt=no-new-privileges'));
    assert.ok(calls[0]?.args.includes('--read-only'));
    assert.ok(calls[0]?.args.includes('--workdir'));
    assert.equal(calls[0]?.args.at(-3), 'helm-coding:test');
    assert.equal(calls[0]?.args.at(-2), 'pnpm');
    assert.equal(calls[0]?.args.at(-1), 'test');
    assert.equal(calls[1]?.args.at(-5), 'python3');
    assert.equal(calls[1]?.args.some((arg) => arg.includes('src/example.txt')), true);
    assert.equal(sandbox.describe().network, 'none');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker sandbox rejects unavailable backend and never falls back to host execution', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-unavailable-');
  try {
    const execFile: DockerExecFile = async () => { const error = Object.assign(new Error('docker daemon unavailable'), { code: 'ENOENT' }); throw error; };
    const sandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile });
    await assert.rejects(() => sandbox.run('pnpm', ['test'], root), (error: unknown) => error instanceof DockerSandboxError && error.unavailable);
    assert.equal(createDockerCodingSandboxFromEnv({ HELM_CODING_SANDBOX: 'docker' }, root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
