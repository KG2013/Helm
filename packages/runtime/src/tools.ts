import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
