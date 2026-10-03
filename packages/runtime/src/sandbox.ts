import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CodingSandbox } from './tools.js';

const execFileAsync = promisify(execFile);
const WRITE_HELPER = [
  'from pathlib import Path',
  'import base64,sys',
  "root=Path('/workspace').resolve()",
  'target=(root / sys.argv[1]).resolve()',
  'if target != root and root not in target.parents: raise SystemExit(31)',
  'target.parent.mkdir(parents=True, exist_ok=True)',
  'target.write_bytes(base64.b64decode(sys.argv[2]))',
].join(';');

export interface DockerExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export type DockerExecFile = (file: string, args: readonly string[], options: DockerExecOptions) => Promise<{ stdout: string; stderr: string }>;

export interface DockerCodingSandboxOptions {
  root: string;
  image: string;
  execFile?: DockerExecFile;
  timeoutMs?: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}

export class DockerSandboxError extends Error {
  readonly unavailable: boolean;
  readonly sideEffect: 'none' | 'unknown';

  constructor(message: string, options: { unavailable?: boolean; sideEffect?: 'none' | 'unknown' } = {}) {
    super(message);
    this.name = 'DockerSandboxError';
    this.unavailable = options.unavailable ?? false;
    this.sideEffect = options.sideEffect ?? 'none';
  }
}

/**
 * Restricted Coding backend. It never invokes a host shell and never writes
 * through the host filesystem; all commands and the fixed write helper run in
 * a network-disabled, non-privileged container with only the workspace mounted.
 */
export class DockerCodingSandbox implements CodingSandbox {
  readonly backend = 'docker';
  private readonly root: string;
  private readonly image: string;
  private readonly runCommand: DockerExecFile;
  private readonly timeoutMs: number;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: number;

  constructor(options: DockerCodingSandboxOptions) {
    if (!options.image.trim()) throw new Error('Docker Coding sandbox requires an image.');
    this.root = resolve(options.root);
    this.image = options.image;
    this.runCommand = options.execFile ?? ((file, args, execOptions) => execFileAsync(file, [...args], { ...execOptions, encoding: 'utf8' }) as Promise<{ stdout: string; stderr: string }>);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.memory = options.memory ?? '512m';
    this.cpus = options.cpus ?? '1';
    this.pidsLimit = options.pidsLimit ?? 128;
  }

  describe(): Record<string, unknown> {
    return { backend: this.backend, image: this.image, network: 'none', memory: this.memory, cpus: this.cpus, pidsLimit: this.pidsLimit };
  }

  async run(command: string, args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    if (resolve(cwd) !== this.root) throw new DockerSandboxError('Docker sandbox cwd must be the canonical workspace root.');
    const result = await this.invoke([command, ...args], options);
    return { exitCode: 0, stdout: result.stdout.slice(0, 64_000), stderr: result.stderr.slice(0, 64_000) };
  }

  async writeFile(path: string, content: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const relativePath = this.relativeWorkspacePath(path);
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    await this.invoke(['python3', '-c', WRITE_HELPER, relativePath, encoded], options);
  }

  private async invoke(command: string[], options: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.runCommand('docker', this.dockerArgs(command), {
        cwd: this.root,
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: 128_000,
        signal: options.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Docker sandbox invocation failed.';
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
      const unavailable = code === 'ENOENT' || /cannot connect|daemon|no such image|pull access denied/i.test(detail);
      throw new DockerSandboxError(unavailable ? 'Docker sandbox is unavailable.' : detail, { unavailable, sideEffect: options.signal?.aborted ? 'unknown' : 'none' });
    }
  }

  private dockerArgs(command: string[]): string[] {
    return [
      'run', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--read-only', '--tmpfs', '/tmp', '--pids-limit', String(this.pidsLimit), '--memory', this.memory,
      '--cpus', this.cpus, '--mount', `type=bind,source=${this.root},target=/workspace,rw`, '--workdir', '/workspace',
      this.image, ...command,
    ];
  }

  private relativeWorkspacePath(path: string): string {
    if (!isAbsolute(path)) throw new DockerSandboxError('Docker write target must be canonical and absolute.');
    const relativePath = relative(this.root, resolve(path));
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new DockerSandboxError('Docker write target is outside the workspace.');
    }
    return relativePath.split(sep).join('/');
  }
}

export function createDockerCodingSandboxFromEnv(env: Record<string, string | undefined>, root: string): DockerCodingSandbox | undefined {
  if (env.HELM_CODING_SANDBOX?.toLowerCase() !== 'docker') return undefined;
  const image = env.HELM_CODING_SANDBOX_IMAGE;
  if (!image) return undefined;
  return new DockerCodingSandbox({ root, image, memory: env.HELM_CODING_SANDBOX_MEMORY, cpus: env.HELM_CODING_SANDBOX_CPUS });
}
