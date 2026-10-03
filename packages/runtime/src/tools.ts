import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MockProvider } from './mock-provider.js';
import { RuntimeFacade } from './runtime.js';
import { TextOutputVerifier, WorkspaceInspectVerifier } from './verifier.js';
import type {
  EventStore,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ToolCall,
  ToolExecutor,
  ToolPolicy,
  ToolProfile,
  ToolRegistry,
  Verifier,
} from './types.js';

export interface CodingSandbox {
  run(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export const workspaceInspectProfile: ToolProfile = {
  id: 'workspace.inspect',
  version: 'v1',
  allowedArguments: ['path'],
  readOnly: true,
  scope: 'workspace',
  network: 'none',
  maxOutputBytes: 32_000,
  description: 'Inspect bounded metadata for a path inside the trusted workspace.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative workspace path.' } },
    additionalProperties: false,
  },
};

export const codingToolProfiles: readonly ToolProfile[] = [
  {
    id: 'workspace.read', version: 'v1', allowedArguments: ['path'], readOnly: true, scope: 'workspace', network: 'none', maxOutputBytes: 64_000,
    description: 'Read a bounded text file inside the trusted workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    id: 'workspace.edit', version: 'v1', allowedArguments: ['path', 'content'], readOnly: false, scope: 'workspace', network: 'none', maxOutputBytes: 64_000,
    description: 'Replace a workspace file under an explicit approval and sandbox boundary.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 64_000 } }, required: ['path', 'content'], additionalProperties: false },
  },
  {
    id: 'workspace.patch', version: 'v1', allowedArguments: ['path', 'oldText', 'newText'], readOnly: false, scope: 'workspace', network: 'none', maxOutputBytes: 64_000,
    description: 'Apply one exact text replacement under an explicit approval and sandbox boundary.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false },
  },
  {
    id: 'workspace.test', version: 'v1', allowedArguments: ['command', 'args'], readOnly: false, scope: 'workspace', network: 'none', maxOutputBytes: 64_000,
    description: 'Run a controlled repository test command through the injected sandbox.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['command'], additionalProperties: false },
  },
  {
    id: 'workspace.diff', version: 'v1', allowedArguments: ['path'], readOnly: true, scope: 'workspace', network: 'none', maxOutputBytes: 64_000,
    description: 'Collect a bounded reviewable diff through the injected sandbox.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  },
];

export class StaticToolRegistry implements ToolRegistry {
  private readonly profiles: ReadonlyMap<string, ToolProfile>;

  constructor(profiles: readonly ToolProfile[]) {
    this.profiles = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  get(id: string): ToolProfile | undefined {
    return this.profiles.get(id);
  }

  list(): ToolProfile[] {
    return [...this.profiles.values()];
  }
}

export function isWorkspaceInspectionGoal(goal: string): boolean {
  return parseWorkspaceInspectionGoal(goal) !== undefined;
}

export function createInspectionAwareProvider(delegate: Provider): Provider {
  if (delegate.id !== 'mock') return delegate;
  const inspectionProvider = new MockProvider([], workspaceInspectionMockResponse);
  return {
    id: delegate.id,
    model: delegate.model,
    capabilities: delegate.capabilities,
    complete: async (request) => isWorkspaceInspectionGoal(request.task.goal)
      ? inspectionProvider.complete(request)
      : delegate.complete(request),
  };
}

export function createTaskAwareVerifier(fallback: Verifier = new TextOutputVerifier()): Verifier {
  const inspectionVerifier = new WorkspaceInspectVerifier();
  return {
    id: 'task-aware-v1',
    verify: async (input) => isWorkspaceInspectionGoal(input.task.goal)
      ? inspectionVerifier.verify(input)
      : fallback.verify(input),
  };
}

export function createWorkspaceInspectionRuntime(options: { store: EventStore; provider: Provider; workspaceId: string; root: string }): RuntimeFacade {
  const registry = new StaticToolRegistry([workspaceInspectProfile]);
  return new RuntimeFacade({
    store: options.store,
    provider: createInspectionAwareProvider(options.provider),
    toolRegistry: registry,
    policy: createReadOnlyWorkspacePolicy(registry, { roots: { [options.workspaceId]: options.root } }),
    executor: createWorkspaceInspectionExecutor({ roots: { [options.workspaceId]: options.root } }),
    verifier: createTaskAwareVerifier(),
  });
}

export function createCodingRuntime(options: { store: EventStore; provider: Provider; workspaceId: string; root: string; sandbox?: CodingSandbox }): RuntimeFacade {
  const registry = new StaticToolRegistry(codingToolProfiles);
  return new RuntimeFacade({
    store: options.store,
    provider: options.provider,
    toolRegistry: registry,
    policy: createCodingPolicy(registry, { roots: { [options.workspaceId]: options.root }, sandboxAvailable: Boolean(options.sandbox) }),
    executor: createCodingExecutor({ roots: { [options.workspaceId]: options.root }, sandbox: options.sandbox }),
    verifier: new CodingVerifier(),
  });
}

export function createCodingPolicy(registry: ToolRegistry, options: { roots: Readonly<Record<string, string>>; sandboxAvailable: boolean }): ToolPolicy {
  return {
    decide: ({ call, task }) => {
      const profile = registry.get(call.name);
      if (!profile) return { decision: 'deny', reason: `Tool ${call.name} is not registered.` };
      if (profile.allowedArguments && Object.keys(call.arguments).some((key) => !profile.allowedArguments?.includes(key))) {
        return { decision: 'deny', reason: 'Coding tool arguments contain an unsupported field.' };
      }
      if (call.name !== 'workspace.read' && call.name !== 'workspace.diff' && !options.sandboxAvailable) {
        return { decision: 'deny', reason: 'Sandbox is unavailable; coding mutation or test execution is rejected.' };
      }
      if (call.name === 'workspace.test' && !options.sandboxAvailable) {
        return { decision: 'deny', reason: 'Sandbox is unavailable; test execution is rejected.' };
      }
      const root = options.roots[task.workspaceId];
      if (!root) return { decision: 'deny', reason: 'Workspace is not registered for coding.' };
      const pathValue = call.arguments.path;
      if (pathValue !== undefined && (typeof pathValue !== 'string' || pathValue.includes('\0') || isAbsolute(pathValue) || !isWithin(resolve(root), resolve(root, pathValue)))) {
        return { decision: 'deny', reason: 'Coding path must stay inside the workspace.' };
      }
      if (call.name === 'workspace.test' || !profile.readOnly) return { decision: 'ask', reason: `Coding action ${call.name}@${profile.version} requires approval.` };
      return { decision: 'allow', reason: `Coding action ${call.name}@${profile.version} is read-only.` };
    },
  };
}

export function createCodingExecutor(options: { roots: Readonly<Record<string, string>>; sandbox?: CodingSandbox }): ToolExecutor {
  return async (call, request) => {
    const rootPath = options.roots[request.task.workspaceId];
    if (!rootPath) return failedCoding('Workspace is not registered for coding.');
    if (call.name === 'workspace.test' || call.name === 'workspace.diff') {
      if (!options.sandbox) return failedCoding('Sandbox is unavailable; host command execution is rejected.');
      const command = call.arguments.command;
      if (call.name === 'workspace.test' && typeof command !== 'string') return failedCoding('Test command is required.');
      const args = Array.isArray(call.arguments.args) && call.arguments.args.every((arg) => typeof arg === 'string') ? call.arguments.args as string[] : [];
      const result = await options.sandbox.run(call.name === 'workspace.diff' ? 'git' : command as string, call.name === 'workspace.diff' ? ['diff', '--no-ext-diff', ...(typeof call.arguments.path === 'string' ? ['--', call.arguments.path] : [])] : args, await realpath(rootPath));
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.slice(0, 64_000);
      return { ok: result.exitCode === 0, output, error: result.exitCode === 0 ? undefined : `Command exited with ${result.exitCode}.`, receipt: { tool: call.name, profile: `${call.name}@v1`, sideEffect: 'known', exitCode: result.exitCode, artifact: codingArtifact(call, output, request.run.id) } };
    }
    const pathValue = call.arguments.path;
    if (typeof pathValue !== 'string' || pathValue.includes('\0') || isAbsolute(pathValue)) return failedCoding('Coding path must stay inside the workspace.');
    const target = await resolveCodingPath(rootPath, pathValue, call.name !== 'workspace.read');
    if (!target) return failedCoding('Coding path could not be safely resolved.');
    if (call.name === 'workspace.read') {
      const content = (await readFile(target, 'utf8')).slice(0, 64_000);
      return { ok: true, output: content, receipt: { tool: call.name, profile: `${call.name}@v1`, sideEffect: 'none', path: pathValue, artifact: codingArtifact(call, content, request.run.id) } };
    }
    if (!options.sandbox) return failedCoding('Sandbox is unavailable; file mutation is rejected.');
    const before = await readFile(target, 'utf8').catch(() => '');
    let after: string;
    if (call.name === 'workspace.edit' && typeof call.arguments.content === 'string') after = call.arguments.content;
    else if (call.name === 'workspace.patch' && typeof call.arguments.oldText === 'string' && typeof call.arguments.newText === 'string') {
      const first = before.indexOf(call.arguments.oldText);
      if (first < 0 || before.indexOf(call.arguments.oldText, first + 1) >= 0) return failedCoding('Patch must match exactly one existing text region.');
      after = `${before.slice(0, first)}${call.arguments.newText}${before.slice(first + call.arguments.oldText.length)}`;
    } else return failedCoding('Coding edit arguments are invalid.');
    if (Buffer.byteLength(after, 'utf8') > 64_000) return failedCoding('Edited file exceeds the bounded limit.');
    const targetBeforeWrite = await resolveCodingPath(rootPath, pathValue, true);
    if (targetBeforeWrite !== target) return failedCoding('Workspace path changed during coding edit.');
    await writeFile(target, after, 'utf8');
    return { ok: true, output: `Updated ${pathValue}.`, receipt: { tool: call.name, profile: `${call.name}@v1`, sideEffect: 'known', path: pathValue, beforeHash: sha256(before), afterHash: sha256(after), artifact: codingArtifact(call, after, request.run.id) } };
  };
}

export class CodingVerifier implements Verifier {
  readonly id = 'coding-v1';

  async verify(input: Parameters<Verifier['verify']>[0]) {
    const receipts = input.context.filter((event) => event.type === 'tool.receipt').map((event) => event.payload as Record<string, unknown>);
    const successful = receipts.filter((receipt) => receipt.ok === true).map((receipt) => ({
      ...receipt,
      ...(receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt as Record<string, unknown> : {}),
    }));
    const hasRead = successful.some((receipt) => receipt.name === 'workspace.read' || receipt.tool === 'workspace.read');
    const hasEdit = successful.some((receipt) => receipt.name === 'workspace.edit' || receipt.name === 'workspace.patch' || receipt.tool === 'workspace.edit' || receipt.tool === 'workspace.patch');
    const test = successful.find((receipt) => receipt.name === 'workspace.test' || receipt.tool === 'workspace.test');
    const diff = successful.find((receipt) => receipt.name === 'workspace.diff' || receipt.tool === 'workspace.diff');
    if (!hasRead || !hasEdit || !test || !diff || test.exitCode !== 0 || !diff.artifact) return { result: 'unknown' as const, verifier: this.id, evidence: [], message: 'Coding Delivery requires read, edit/patch, passing test, and diff evidence.' };
    return { result: 'passed' as const, verifier: this.id, evidence: [{ type: 'coding-artifact', summary: 'Read, edit, test, and diff receipts are present.' }], message: 'Coding artifact is ready for delivery.' };
  }
}

export function createReadOnlyWorkspacePolicy(registry: ToolRegistry, options: { roots?: Readonly<Record<string, string>> } = {}): ToolPolicy {
  return {
    decide: ({ call, task }) => {
      const profile = registry.get(call.name);
      if (!profile) return { decision: 'deny', reason: `Tool ${call.name} is not registered.` };
      if (!profile.readOnly || profile.scope !== 'workspace' || profile.network !== 'none') {
        return { decision: 'deny', reason: `Tool ${call.name} is outside the read-only workspace policy.` };
      }
      if (profile.allowedArguments && Object.keys(call.arguments).some((key) => !profile.allowedArguments?.includes(key))) {
        return { decision: 'deny', reason: 'Inspection arguments contain an unsupported field.' };
      }
      const requestedPath = call.arguments.path;
      if (requestedPath !== undefined && (typeof requestedPath !== 'string' || requestedPath.includes('\0') || isAbsolute(requestedPath))) {
        return { decision: 'deny', reason: 'Inspection path must stay inside the workspace.' };
      }
      const root = options.roots?.[task.workspaceId];
      if (!root) return { decision: 'deny', reason: 'Workspace is not registered for inspection.' };
      if (typeof requestedPath === 'string' && !isWithin(resolve(root), resolve(root, requestedPath))) {
        return { decision: 'deny', reason: 'Inspection path is outside the workspace.' };
      }
      return { decision: 'allow', reason: `Tool ${call.name}@${profile.version} is explicitly allowed for workspace inspection.` };
    },
  };
}

export function createWorkspaceInspectionExecutor(options: { roots: Readonly<Record<string, string>> }): ToolExecutor {
  return async (call: ToolCall, request: ProviderRequest) => {
    const workspaceId = request.task.workspaceId;
    const rootPath = options.roots[workspaceId];
    if (!rootPath) return failedInspection('Workspace is not registered for inspection.');
    if (call.name !== workspaceInspectProfile.id) return failedInspection(`Tool ${call.name} is not registered.`);
    if (Object.keys(call.arguments).some((key) => key !== 'path')) return failedInspection('Inspection arguments contain an unsupported field.');
    const requestedPath = call.arguments.path;
    if (requestedPath !== undefined && typeof requestedPath !== 'string') return failedInspection('Inspection path must be a string.');
    const relativePath = requestedPath ?? '.';
    if (relativePath.includes('\0') || isAbsolute(relativePath)) return failedInspection('Inspection path must stay inside the workspace.');

    try {
      const root = await realpath(rootPath);
      const candidate = resolve(root, relativePath);
      if (!isWithin(root, candidate)) return failedInspection('Inspection path is outside the workspace.');
      const candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink()) return failedInspection('Symlink inspection is rejected.');
      const targetBefore = await realpath(candidate);
      if (!isWithin(root, targetBefore)) return failedInspection('Symlink escape is rejected.');
      const canonicalPath = normalizeRelative(relative(root, targetBefore));
      const targetStatBefore = await lstat(targetBefore);
      if (targetStatBefore.isSymbolicLink()) return failedInspection('Symlink inspection is rejected.');
      if (!sameFile(candidateStat, targetStatBefore)) return failedInspection('Workspace path changed during inspection.');
      const metadata = inspectPath(targetStatBefore, canonicalPath);
      const targetStatAfter = await lstat(targetBefore);
      const targetAfter = await realpath(candidate);
      if (targetBefore !== targetAfter || !isWithin(root, targetAfter) || !sameFile(targetStatBefore, targetStatAfter)) {
        return failedInspection('Workspace path changed during inspection.');
      }
      const output = JSON.stringify(metadata);
      if (Buffer.byteLength(output, 'utf8') > workspaceInspectProfile.maxOutputBytes) return failedInspection('Inspection output exceeds the bounded limit.');
      const hash = createHash('sha256').update(output).digest('hex');
      const uri = `workspace://${encodeURIComponent(workspaceId)}/${toUriPath(canonicalPath)}`;
      return {
        ok: true,
        output,
        receipt: {
          tool: workspaceInspectProfile.id,
          profile: `${workspaceInspectProfile.id}@${workspaceInspectProfile.version}`,
          sideEffect: 'none',
          workspaceId,
          path: canonicalPath,
          artifact: { type: 'workspace-inspection', uri, hash },
        },
      };
    } catch (error) {
      if (isMissingPath(error)) return failedInspection('Inspection path does not exist.');
      return failedInspection('Workspace inspection could not safely resolve the path.');
    }
  };
}

export function workspaceInspectionMockResponse(request: ProviderRequest): ProviderResponse | undefined {
  const match = parseWorkspaceInspectionGoal(request.task.goal);
  if (!match) return undefined;
  const successfulReceipt = request.context.some((event) => {
    if (event.type !== 'tool.receipt') return false;
    const payload = event.payload as { ok?: boolean; receipt?: { artifact?: { type?: string } } };
    return payload.ok === true && payload.receipt?.artifact?.type === 'workspace-inspection';
  });
  if (successfulReceipt) return { kind: 'final', content: 'Workspace inspection completed.', provider: 'workspace-inspect', model: 'workspace-inspect-v1' };
  return { kind: 'tool_call', name: workspaceInspectProfile.id, arguments: { path: match[1]?.trim() || '.' }, provider: 'workspace-inspect', model: 'workspace-inspect-v1' };
}

function parseWorkspaceInspectionGoal(goal: string): RegExpExecArray | undefined {
  return /^inspect(?:\s+([^\s]+))?$/i.exec(goal.trim()) ?? undefined;
}

function inspectPath(stat: Awaited<ReturnType<typeof lstat>>, requestedPath: string): Record<string, unknown> {
  return {
    path: normalizeRelative(requestedPath),
    kind: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function failedInspection(error: string) {
  return {
    ok: false,
    error,
    receipt: {
      tool: workspaceInspectProfile.id,
      profile: `${workspaceInspectProfile.id}@${workspaceInspectProfile.version}`,
      sideEffect: 'none',
    },
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function normalizeRelative(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '') || '.';
}

function toUriPath(value: string): string {
  return normalizeRelative(value).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function failedCoding(error: string) {
  return { ok: false, error, receipt: { sideEffect: 'none', tool: 'coding', profile: 'coding@v1' } };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codingArtifact(call: ToolCall, content: string, runId: string): Record<string, unknown> {
  return { type: 'coding', sourceRunId: runId, action: call.name, path: typeof call.arguments.path === 'string' ? call.arguments.path : undefined, hash: sha256(content), bytes: Buffer.byteLength(content, 'utf8') };
}

async function resolveCodingPath(rootPath: string, requestedPath: string, forWrite: boolean): Promise<string | undefined> {
  try {
    const root = await realpath(rootPath);
    const candidate = resolve(root, requestedPath);
    if (!isWithin(root, candidate)) return undefined;
    const parent = await realpath(dirname(candidate));
    if (!isWithin(root, parent)) return undefined;
    const stat = await lstat(candidate).catch(() => undefined);
    if (stat?.isSymbolicLink()) return undefined;
    if (!forWrite && !stat) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}
