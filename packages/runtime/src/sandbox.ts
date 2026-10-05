import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import type { CodingSandbox } from './tools.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64_000;
const MAX_EXEC_BUFFER = MAX_OUTPUT_BYTES * 2;
const IMAGE_DIGEST_PATTERN = /.+@sha256:[a-f0-9]{64}$/i;
const MEMORY_PATTERN = /^\d+(?:[kmgt]i?|[kmgt]b)?$/i;
const CPU_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const USER_PATTERN = /^(\d+)(?::(\d+))?$/;
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

export type DockerExecFile = (file: string, args: readonly string[], options: DockerExecOptions) => Promise<{ stdout: string; stderr: string; exitCode?: number }>;

export interface DockerCodingSandboxOptions {
  root: string;
  image: string;
  execFile?: DockerExecFile;
  timeoutMs?: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** Require an immutable image reference. The environment factory enables this. */
  requireDigest?: boolean;
  /** Run daemon/image/security preflight before the first container operation. */
  preflight?: boolean;
  /** Numeric non-root uid[:gid]. Root is never accepted. */
  user?: string;
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
  private readonly user: string;
  private readonly preflightEnabled: boolean;
  private preflightPromise?: Promise<void>;

  constructor(options: DockerCodingSandboxOptions) {
    const image = options.image.trim();
    if (!image) throw new Error('Docker Coding sandbox requires an image.');
    if (options.requireDigest && !IMAGE_DIGEST_PATTERN.test(image)) {
      throw new DockerSandboxError('Docker sandbox image must be pinned by sha256 digest.', { unavailable: true });
    }
    if (!MEMORY_PATTERN.test(options.memory ?? '512m')) throw new Error('Docker sandbox memory limit is invalid.');
    if (!CPU_PATTERN.test(options.cpus ?? '1') || Number(options.cpus ?? '1') <= 0) throw new Error('Docker sandbox CPU limit is invalid.');
    const pidsLimit = options.pidsLimit ?? 128;
    if (!Number.isInteger(pidsLimit) || pidsLimit < 1 || pidsLimit > 4096) throw new Error('Docker sandbox pids limit is invalid.');
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error('Docker sandbox timeout is invalid.');
    const user = options.user ?? '65532:65532';
    const userMatch = USER_PATTERN.exec(user);
    if (!userMatch || Number(userMatch[1]) < 1 || Number(userMatch[1]) > 65535 || (userMatch[2] !== undefined && Number(userMatch[2]) > 65535)) {
      throw new Error('Docker sandbox user must be a numeric non-root uid[:gid].');
    }
    const root = realpathSync(options.root);
    if (!statSync(root).isDirectory()) throw new Error('Docker sandbox workspace root must be a directory.');
    this.root = root;
    this.image = image;
    this.runCommand = options.execFile ?? ((file, args, execOptions) => execFileAsync(file, [...args], { ...execOptions, encoding: 'utf8' }) as Promise<{ stdout: string; stderr: string }>);
    this.timeoutMs = timeoutMs;
    this.memory = options.memory ?? '512m';
    this.cpus = options.cpus ?? '1';
    this.pidsLimit = pidsLimit;
    this.user = user;
    this.preflightEnabled = options.preflight ?? false;
  }

  describe(): Record<string, unknown> {
    return {
      backend: this.backend,
      image: this.image,
      imageDigestPinned: IMAGE_DIGEST_PATTERN.test(this.image),
      network: 'none',
      user: this.user,
      readOnlyRoot: true,
      workspaceMount: 'rw:/workspace',
      cleanup: 'docker --rm',
      memory: this.memory,
      cpus: this.cpus,
      pidsLimit: this.pidsLimit,
      outputLimitBytes: MAX_OUTPUT_BYTES,
      preflight: this.preflightEnabled ? 'required' : 'disabled',
    };
  }

  async run(command: string, args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    let canonicalCwd: string;
    try {
      canonicalCwd = realpathSync(cwd);
    } catch {
      throw new DockerSandboxError('Docker sandbox cwd must be the canonical workspace root.');
    }
    if (canonicalCwd !== this.root) throw new DockerSandboxError('Docker sandbox cwd must be the canonical workspace root.');
    this.validateCommand(command, args);
    await this.ensurePreflight();
    const result = await this.invoke([command, ...args], options);
    return { exitCode: result.exitCode, stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr) };
  }

  async writeFile(path: string, content: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const relativePath = this.relativeWorkspacePath(path);
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    await this.ensurePreflight();
    await this.invoke(['python3', '-c', WRITE_HELPER, relativePath, encoded], options);
  }

  /** Explicitly run daemon, image and security-option checks for target-environment smoke. */
  async preflight(): Promise<{ image: string; securityOptions: string[] }> {
    const info = await this.execDocker(['info', '--format', '{{json .SecurityOptions}}'], { timeoutMs: Math.min(this.timeoutMs, 10_000) });
    let securityOptions: unknown;
    try {
      securityOptions = JSON.parse(info.stdout.trim());
    } catch {
      throw new DockerSandboxError('Docker security preflight returned invalid metadata.', { unavailable: true });
    }
    if (!Array.isArray(securityOptions) || !securityOptions.every((item) => typeof item === 'string') || securityOptions.length === 0) {
      throw new DockerSandboxError('Docker security options are unavailable.', { unavailable: true });
    }
    const image = await this.execDocker(['image', 'inspect', '--format', '{{.Id}}', this.image], { timeoutMs: Math.min(this.timeoutMs, 10_000) });
    if (!/^sha256:[a-f0-9]{64}$/i.test(image.stdout.trim())) {
      throw new DockerSandboxError('Docker sandbox image could not be verified.', { unavailable: true });
    }
    return { image: this.image, securityOptions: securityOptions as string[] };
  }

  private async ensurePreflight(): Promise<void> {
    if (!this.preflightEnabled) return;
    this.preflightPromise ??= this.preflight().then(() => undefined).catch((error) => {
      this.preflightPromise = undefined;
      throw error;
    });
    await this.preflightPromise;
  }

  private async invoke(command: string[], options: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.execDocker(['run', '--pull=never', '--rm', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp', '--pids-limit', String(this.pidsLimit), '--memory', this.memory, '--cpus', this.cpus, '--user', this.user, '--mount', `type=bind,source=${this.root},target=/workspace,bind-propagation=rprivate`, '--workdir', '/workspace', this.image, ...command], options);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  private async execDocker(args: string[], options: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await this.runCommand('docker', args, {
        cwd: this.root,
        timeout: options.timeoutMs ?? this.timeoutMs,
        maxBuffer: MAX_EXEC_BUFFER,
        signal: options.signal,
      });
      return { stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr), exitCode: result.exitCode ?? 0 };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      const record = error && typeof error === 'object' ? error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown } : {};
      const code = record.code;
      const stdout = typeof record.stdout === 'string' ? record.stdout : '';
      const stderr = typeof record.stderr === 'string' ? record.stderr : '';
      const diagnostic = `${detail}\n${stderr}`;
      const engineUnavailable = code === 'ENOENT' || code === 125 || /cannot connect|daemon|no such image|pull access denied|repository does not exist|failed to create task|security option|permission denied/i.test(diagnostic);
      if (typeof code === 'number' && code >= 0 && !engineUnavailable && !record.killed) {
        return { stdout: boundedOutput(stdout), stderr: boundedOutput(stderr), exitCode: code };
      }
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxbuffer|output limit/i.test(detail)) {
        throw new DockerSandboxError('Docker sandbox output limit exceeded.', { sideEffect: 'unknown' });
      }
      const timedOut = code === 'ETIMEDOUT' || /timed out|timeout/i.test(diagnostic) || record.killed === true;
      if (timedOut || options.signal?.aborted) {
        throw new DockerSandboxError('Docker sandbox command timed out or was cancelled.', { sideEffect: 'unknown' });
      }
      throw new DockerSandboxError(engineUnavailable ? 'Docker sandbox is unavailable.' : 'Docker sandbox invocation failed.', { unavailable: engineUnavailable, sideEffect: 'none' });
    }
  }

  private validateCommand(command: string, args: string[]): void {
    if (!command || command.includes('\0') || args.some((arg) => arg.includes('\0'))) throw new DockerSandboxError('Docker sandbox command contains an invalid argument.');
  }

  private relativeWorkspacePath(path: string): string {
    if (!isAbsolute(path)) throw new DockerSandboxError('Docker write target must be canonical and absolute.');
    const relativePath = relative(this.root, canonicalizePath(path));
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new DockerSandboxError('Docker write target is outside the workspace.');
    }
    return relativePath.split(sep).join('/');
  }
}

/** Resolve an absolute path while retaining non-existent leaf segments. This
 * makes a /tmp alias and symlinked parent visible to the same boundary check. */
function canonicalizePath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(join(realpathSync(current), ...suffix));
}

export function createDockerCodingSandboxFromEnv(env: Record<string, string | undefined>, root: string): DockerCodingSandbox | undefined {
  if (env.HELM_CODING_SANDBOX?.toLowerCase() !== 'docker') return undefined;
  const image = env.HELM_CODING_SANDBOX_IMAGE;
  if (!image || !IMAGE_DIGEST_PATTERN.test(image.trim())) return undefined;
  try {
    return new DockerCodingSandbox({
      root,
      image,
      memory: env.HELM_CODING_SANDBOX_MEMORY,
      cpus: env.HELM_CODING_SANDBOX_CPUS,
      pidsLimit: env.HELM_CODING_SANDBOX_PIDS ? Number(env.HELM_CODING_SANDBOX_PIDS) : undefined,
      user: env.HELM_CODING_SANDBOX_USER,
      requireDigest: true,
      preflight: true,
    });
  } catch {
    return undefined;
  }
}

function boundedOutput(value: string): string {
  const marker = '\n[output truncated]';
  if (Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES) return value;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let prefix = Buffer.from(value, 'utf8').subarray(0, MAX_OUTPUT_BYTES - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') + markerBytes > MAX_OUTPUT_BYTES) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}
