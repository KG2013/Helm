import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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
    assert.ok(calls[0]?.args.includes('--pull=never'));
    assert.ok(calls[0]?.args.includes('--network=none'));
    assert.ok(calls[0]?.args.includes('--cap-drop=ALL'));
    assert.ok(calls[0]?.args.includes('--security-opt=no-new-privileges'));
    assert.ok(calls[0]?.args.includes('--read-only'));
    assert.ok(calls[0]?.args.includes('--user'));
    assert.ok(calls[0]?.args.includes('65532:65532'));
    const mount = calls[0]?.args.find((arg) => arg.includes('bind-propagation=rprivate'));
    assert.ok(mount);
    assert.doesNotMatch(mount, /,rw,/);
    assert.ok(calls[0]?.args.includes('--workdir'));
    assert.equal(calls[0]?.args.at(-3), 'helm-coding:test');
    assert.equal(calls[0]?.args.at(-2), 'pnpm');
    assert.equal(calls[0]?.args.at(-1), 'test');
    assert.equal(calls[1]?.args.at(-5), 'python3');
    assert.equal(calls[1]?.args.some((arg) => arg.includes('src/example.txt')), true);
    assert.equal(sandbox.describe().network, 'none');
    assert.equal(sandbox.describe().imageDigestPinned, false);
    assert.equal(sandbox.describe().outputLimitBytes, 64_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker sandbox preserves bounded non-zero exit codes and truncates output', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-exit-');
  try {
    const execFile: DockerExecFile = async () => {
      const error = Object.assign(new Error('command failed'), { code: 17, stdout: 'stdout', stderr: 'stderr' });
      throw error;
    };
    const sandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile });
    const result = await sandbox.run('pnpm', ['test'], root);
    assert.equal(result.exitCode, 17);
    assert.equal(result.stdout, 'stdout');
    assert.equal(result.stderr, 'stderr');

    const noisy: DockerExecFile = async () => ({ stdout: 'x'.repeat(80_000), stderr: '' });
    const noisySandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile: noisy });
    const noisyResult = await noisySandbox.run('pnpm', ['test'], root);
    assert.equal(noisyResult.stdout.length, 64_000);
    assert.match(noisyResult.stdout, /\[output truncated\]$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker sandbox maps timeout and output overflow to unknown side effects', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-failure-');
  try {
    const timeoutExec: DockerExecFile = async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
    const timeoutSandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile: timeoutExec });
    await assert.rejects(() => timeoutSandbox.run('pnpm', ['test'], root), (error: unknown) => error instanceof DockerSandboxError && error.sideEffect === 'unknown');

    const overflowExec: DockerExecFile = async () => { throw Object.assign(new Error('max buffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }); };
    const overflowSandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile: overflowExec });
    await assert.rejects(() => overflowSandbox.run('pnpm', ['test'], root), (error: unknown) => error instanceof DockerSandboxError && error.sideEffect === 'unknown' && /output limit/i.test(error.message));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker sandbox preflight requires daemon metadata and a verified image digest', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-preflight-');
  try {
    const digest = 'sha256:' + 'a'.repeat(64);
    const calls: string[][] = [];
    const execFile: DockerExecFile = async (_file, args) => {
      calls.push([...args]);
      if (args[0] === 'info') return { stdout: '["name=seccomp"]', stderr: '' };
      if (args[0] === 'image') return { stdout: digest, stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    const sandbox = new DockerCodingSandbox({ root, image: `registry.example/helm@${digest}`, execFile, requireDigest: true, preflight: true });
    await sandbox.run('pnpm', ['test'], root);
    assert.deepEqual(calls[0], ['info', '--format', '{{json .SecurityOptions}}']);
    assert.deepEqual(calls[1], ['image', 'inspect', '--format', '{{.Id}}', `registry.example/helm@${digest}`]);
    assert.equal(calls[2]?.[0], 'run');
    assert.equal(sandbox.describe().imageDigestPinned, true);

    const missingSecurity: DockerExecFile = async (_file, args) => args[0] === 'info' ? { stdout: '[]', stderr: '' } : { stdout: digest, stderr: '' };
    const missingSecuritySandbox = new DockerCodingSandbox({ root, image: `registry.example/helm@${digest}`, execFile: missingSecurity, requireDigest: true, preflight: true });
    await assert.rejects(() => missingSecuritySandbox.run('pnpm', ['test'], root), (error: unknown) => error instanceof DockerSandboxError && error.unavailable);
    assert.equal(createDockerCodingSandboxFromEnv({ HELM_CODING_SANDBOX: 'docker', HELM_CODING_SANDBOX_IMAGE: 'registry.example/helm:latest' }, root), undefined);
    const configured = createDockerCodingSandboxFromEnv({ HELM_CODING_SANDBOX: 'docker', HELM_CODING_SANDBOX_IMAGE: `registry.example/helm@${digest}` }, root);
    assert.equal(configured?.describe().imageDigestPinned, true);
    assert.equal(configured?.describe().preflight, 'required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Docker sandbox rejects symlinked write targets before invoking Docker', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-symlink-');
  const outside = await mkdtemp('/tmp/helm-sandbox-outside-');
  try {
    const calls: string[][] = [];
    const execFile: DockerExecFile = async (_file, args) => { calls.push([...args]); return { stdout: 'ok', stderr: '' }; };
    await symlink(outside, `${root}/escape`, 'dir');
    const sandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile });
    await assert.rejects(() => sandbox.writeFile(`${root}/escape/secret.txt`, 'private'), /outside the workspace/);
    assert.equal(calls.length, 0);
    await mkdir(`${root}/safe`, { recursive: true });
    await sandbox.writeFile(`${root}/safe/file.txt`, 'safe');
    assert.equal(calls.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Docker sandbox rejects unavailable backend and never falls back to host execution', async () => {
  const root = await mkdtemp('/tmp/helm-sandbox-unavailable-');
  try {
    const execFile: DockerExecFile = async () => { const error = Object.assign(new Error('docker daemon unavailable'), { code: 'ENOENT' }); throw error; };
    const sandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile });
    await assert.rejects(() => sandbox.run('pnpm', ['test'], root), (error: unknown) => error instanceof DockerSandboxError && error.unavailable);
    const daemonExec: DockerExecFile = async () => { throw Object.assign(new Error('docker exited'), { code: 1, stderr: 'Cannot connect to the Docker daemon' }); };
    const daemonSandbox = new DockerCodingSandbox({ root, image: 'helm-coding:test', execFile: daemonExec });
    await assert.rejects(() => daemonSandbox.run('pnpm', ['test'], root), (error: unknown) => error instanceof DockerSandboxError && error.unavailable);
    assert.equal(createDockerCodingSandboxFromEnv({ HELM_CODING_SANDBOX: 'docker' }, root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
