import { isAbsolute, relative, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { RuntimeFacade } from './runtime.js';
import type {
  Evidence,
  Provider,
  ToolCall,
  ToolExecutor,
  ToolPolicy,
  ToolProfile,
  ToolRegistry,
  Verifier,
  VerifierInput,
  Verification,
} from './types.js';
import { StaticToolRegistry } from './tools.js';

/** The small protocol boundary between Runtime and the Python document worker. */
export interface OfficeWorkerRequest {
  id: string;
  runId: string;
  operation: 'docx_create' | 'xlsx_read_range' | 'xlsx_write_range' | 'pdf_extract';
  path: string;
  [key: string]: unknown;
}

export interface OfficeWorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  receipt?: Record<string, unknown>;
}

export interface OfficeWorkerClient {
  execute(request: OfficeWorkerRequest, signal?: AbortSignal): Promise<OfficeWorkerResponse>;
}

export interface PythonDocumentWorkerOptions {
  scriptPath: string;
  python?: string;
  workspaceRoot: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** Spawn one bounded JSONL worker request; the worker never receives provider credentials. */
export class PythonDocumentWorkerClient implements OfficeWorkerClient {
  private readonly options: Required<Pick<PythonDocumentWorkerOptions, 'python' | 'timeoutMs' | 'maxResponseBytes'>> & PythonDocumentWorkerOptions;

  constructor(options: PythonDocumentWorkerOptions) {
    this.options = {
      python: 'python3',
      timeoutMs: 120_000,
      maxResponseBytes: 256_000,
      ...options,
    };
  }

  execute(request: OfficeWorkerRequest, signal?: AbortSignal): Promise<OfficeWorkerResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.python, [this.options.scriptPath], {
        cwd: this.options.workspaceRoot,
        env: workerEnvironment(this.options.env, this.options.workspaceRoot),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => finishError(new Error('Document Worker timed out.')), this.options.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const finish = (value: OfficeWorkerResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      };
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill('SIGKILL');
        rejectPromise(error);
      };
      const onAbort = () => finishError(new Error('Document Worker request aborted.'));
      child.once('error', (error) => finishError(error));
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout, 'utf8') > this.options.maxResponseBytes) finishError(new Error('Document Worker response exceeded its bound.'));
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk).slice(0, 4_000);
      });
      child.once('close', (code) => {
        if (settled) return;
        const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
        if (!line) {
          finishError(new Error(`Document Worker exited without a response${code === null ? '' : ` (code ${code})`}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}.`));
          return;
        }
        try {
          const parsed = JSON.parse(line) as OfficeWorkerResponse;
          if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || parsed.id !== request.id || typeof parsed.ok !== 'boolean') throw new Error('invalid worker response');
          finish(parsed);
        } catch {
          finishError(new Error('Document Worker returned invalid JSON.'));
        }
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}

export const officeToolProfiles: readonly ToolProfile[] = [
  {
    id: 'office.docx.create',
    version: 'v1',
    allowedArguments: ['path', 'paragraphs'],
    readOnly: false,
    scope: 'workspace',
    network: 'none',
    maxOutputBytes: 64_000,
    description: 'Create a bounded DOCX artifact through the Document Worker.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' }, maxItems: 200 } },
      required: ['path', 'paragraphs'],
      additionalProperties: false,
    },
  },
  {
    id: 'office.xlsx.read_range',
    version: 'v1',
    allowedArguments: ['path', 'sheet', 'cell', 'range'],
    readOnly: true,
    scope: 'workspace',
    network: 'none',
    maxOutputBytes: 64_000,
    description: 'Read one bounded XLSX cell or range through the Document Worker.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, sheet: { type: 'string' }, cell: { type: 'string' }, range: { type: 'string' } },
      required: ['path', 'sheet'],
      additionalProperties: false,
    },
  },
  {
    id: 'office.xlsx.write_range',
    version: 'v1',
    allowedArguments: ['path', 'sheet', 'cell', 'range', 'value', 'values'],
    readOnly: false,
    scope: 'workspace',
    network: 'none',
    maxOutputBytes: 64_000,
    description: 'Write one bounded XLSX cell or range through the Document Worker.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        sheet: { type: 'string' },
        cell: { type: 'string' },
        range: { type: 'string' },
        value: {},
        values: { type: 'array', maxItems: 100 },
      },
      required: ['path', 'sheet'],
      additionalProperties: false,
    },
  },
  {
    id: 'office.pdf.extract',
    version: 'v1',
    allowedArguments: ['path'],
    readOnly: true,
    scope: 'workspace',
    network: 'none',
    maxOutputBytes: 64_000,
    description: 'Extract PDF text-layer pages and source metadata through the Document Worker.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
];

export interface OfficeRuntimeOptions {
  store: ConstructorParameters<typeof RuntimeFacade>[0]['store'];
  provider: Provider;
  worker: OfficeWorkerClient;
  workspaceId: string;
  root: string;
  ownerId?: string;
}

export function createOfficeRuntime(options: OfficeRuntimeOptions): RuntimeFacade {
  const registry = new StaticToolRegistry(officeToolProfiles);
  return new RuntimeFacade({
    store: options.store,
    provider: options.provider,
    toolRegistry: registry,
    policy: createOfficePolicy(registry, { roots: { [options.workspaceId]: options.root } }),
    executor: createOfficeExecutor({ roots: { [options.workspaceId]: options.root }, worker: options.worker }),
    verifier: new OfficeVerifier(),
    ownerId: options.ownerId,
  });
}

export function createOfficePolicy(
  registry: ToolRegistry,
  options: { roots: Readonly<Record<string, string>> },
): ToolPolicy {
  return {
    id: 'office-policy',
    version: 'v1',
    decide: ({ call, task }) => {
      const profile = registry.get(call.name);
      if (!profile) return { decision: 'deny', reason: `Tool ${call.name} is not registered.` };
      if (profile.scope !== 'workspace' || profile.network !== 'none') {
        return { decision: 'deny', reason: `Office tool ${call.name} is outside the local workspace policy.` };
      }
      if (profile.allowedArguments && Object.keys(call.arguments).some((key) => !profile.allowedArguments?.includes(key))) {
        return { decision: 'deny', reason: 'Office tool arguments contain an unsupported field.' };
      }
      const root = options.roots[task.workspaceId];
      if (!root) return { decision: 'deny', reason: 'Workspace is not registered for Office operations.' };
      const pathValue = call.arguments.path;
      if (typeof pathValue !== 'string' || !isSafeWorkspacePath(root, pathValue)) {
        return { decision: 'deny', reason: 'Office path must stay inside the workspace.' };
      }
      if (!hasExactlyOneRangeSelector(call.arguments) && (call.name === 'office.xlsx.read_range' || call.name === 'office.xlsx.write_range')) {
        return { decision: 'deny', reason: 'XLSX operation requires a cell or range selector.' };
      }
      if (call.name === 'office.xlsx.write_range' && !hasValidWriteValue(call.arguments)) {
        return { decision: 'deny', reason: 'XLSX write requires a scalar value or a values matrix.' };
      }
      if (profile.readOnly) return { decision: 'allow', reason: `Office action ${call.name}@${profile.version} is read-only.` };
      return { decision: 'ask', reason: `Office action ${call.name}@${profile.version} changes a local artifact and requires approval.` };
    },
  };
}

export function createOfficeExecutor(options: { roots: Readonly<Record<string, string>>; worker: OfficeWorkerClient }): ToolExecutor {
  return async (call: ToolCall, request) => {
    const root = options.roots[request.task.workspaceId];
    if (!root) return failedOffice('Workspace is not registered for Office operations.');
    const pathValue = call.arguments.path;
    if (typeof pathValue !== 'string' || !isSafeWorkspacePath(root, pathValue) || !(await isSafeOfficeTarget(root, pathValue))) {
      return failedOffice('Office path must stay inside the workspace.');
    }
    const operation = operationFor(call.name);
    if (!operation) return failedOffice(`Tool ${call.name} is not registered.`);
    const workerRequest: OfficeWorkerRequest = {
      id: call.id,
      runId: request.run.id,
      operation,
      ...call.arguments,
      path: pathValue,
    };
    let response: OfficeWorkerResponse;
    try {
      response = await options.worker.execute(workerRequest, request.signal);
    } catch (error) {
      return { ok: false, error: sanitizeError(error), receipt: { worker: 'document-worker', operation, sideEffect: 'unknown' } };
    }
    const sideEffect = response.receipt?.sideEffect === 'unknown'
      ? 'unknown'
      : isMutatingOfficeTool(call.name) ? 'known' : 'none';
    const normalizedReceipt: Record<string, unknown> = {
      worker: response.receipt?.worker ?? 'document-worker',
      workerVersion: response.receipt?.workerVersion,
      operation,
      profile: `${call.name}@v1`,
      sideEffect,
      artifact: normalizeArtifact(response.receipt?.artifact, request.task.workspaceId, request.run.id),
      checks: response.receipt?.checks,
      target: response.receipt?.target,
      limitations: response.receipt?.limitations,
      workerReceipt: response.receipt,
    };
    const unknownEvidence = response.error === 'unknown_text_layer'
      || response.receipt?.verification === 'unknown'
      || response.receipt?.checks && hasUnknownCheck(response.receipt.checks);
    if (unknownEvidence) {
      return {
        ok: true,
        output: response.result ?? { error: response.error },
        receipt: { ...normalizedReceipt, verification: 'unknown' },
      };
    }
    if (!response.ok) {
      return { ok: false, error: response.error ?? 'Document Worker operation failed.', receipt: normalizedReceipt };
    }
    return {
      ok: true,
      output: response.result,
      receipt: normalizedReceipt,
    };
  };
}

export class OfficeVerifier implements Verifier {
  readonly id = 'office-v1';

  async verify(input: VerifierInput): Promise<Verification> {
    const receipts = input.context
      .filter((event) => event.type === 'tool.receipt')
      .map((event) => event.payload as Record<string, unknown>)
      .filter((payload) => payload.ok === true && isOfficeReceipt(payload.receipt));
    const receipt = receipts.at(-1);
    if (!input.output.trim() || !receipt) return unknownOffice('Office delivery has no successful worker receipt.');
    const office = receipt.receipt as Record<string, unknown>;
    const artifact = office.artifact as Record<string, unknown> | undefined;
    if (!artifact?.uri || !isSha256(artifact.hash) || artifact.sourceRunId !== input.run.id) {
      return unknownOffice('Office artifact receipt is missing a workspace URI, hash, or source Run.');
    }
    const operation = String(office.operation);
    if (office.sideEffect === 'unknown') {
      return unknownOffice('Office evidence has an unknown side effect.', artifact);
    }
    if (office.verification === 'unknown' || hasUnknownCheck(office.checks)) {
      if (operation === 'docx_create' && (office.checks as Record<string, unknown> | undefined)?.rendering === 'unknown') {
        return unknownOffice('DOCX rendering evidence is unknown.', artifact);
      }
      if (operation === 'pdf_extract' && (office.checks as Record<string, unknown> | undefined)?.coverage === 'unknown') {
        return unknownOffice('PDF page coverage or OCR evidence is unknown.', artifact);
      }
      if (operation === 'xlsx_write_range' && (office.checks as Record<string, unknown> | undefined)?.scope === 'unknown') {
        return unknownOffice('XLSX unauthorized-scope evidence is unknown.', artifact);
      }
      return unknownOffice('Office evidence is incomplete.', artifact);
    }
    if (operation === 'docx_create' && !allChecksPassed(office.checks, ['structure', 'content', 'rendering'])) {
      return unknownOffice('DOCX requires structure, content, and rendering evidence.', artifact);
    }
    if (operation === 'xlsx_write_range' && !allChecksPassed(office.checks, ['target', 'scope'])) {
      return unknownOffice('XLSX delivery requires target-value and unauthorized-scope checks.', artifact);
    }
    if (operation === 'xlsx_read_range' && !allChecksPassed(office.checks, ['target'])) {
      return unknownOffice('XLSX read delivery requires target-range evidence.', artifact);
    }
    if (operation === 'pdf_extract' && !allChecksPassed(office.checks, ['coverage', 'sources'])) {
      return unknownOffice('PDF delivery requires complete page coverage and page-source evidence.', artifact);
    }
    const evidence: Evidence[] = [{
      type: `office-${operation}`,
      summary: `${operation} worker receipt passed its evidence checks.`,
      uri: String(artifact.uri),
      hash: String(artifact.hash),
    }];
    return { result: 'passed', verifier: this.id, evidence, message: 'Office artifact passed the configured evidence checks.' };
  }
}

function operationFor(name: string): OfficeWorkerRequest['operation'] | undefined {
  if (name === 'office.docx.create') return 'docx_create';
  if (name === 'office.xlsx.read_range') return 'xlsx_read_range';
  if (name === 'office.xlsx.write_range') return 'xlsx_write_range';
  if (name === 'office.pdf.extract') return 'pdf_extract';
  return undefined;
}

function isMutatingOfficeTool(name: string): boolean {
  return name === 'office.docx.create' || name === 'office.xlsx.write_range';
}

function hasExactlyOneRangeSelector(args: Record<string, unknown>): boolean {
  const cell = typeof args.cell === 'string' && args.cell.length > 0;
  const range = typeof args.range === 'string' && args.range.length > 0;
  return cell !== range;
}

function hasValidWriteValue(args: Record<string, unknown>): boolean {
  const scalar = Object.prototype.hasOwnProperty.call(args, 'value');
  const matrix = Array.isArray(args.values);
  return scalar !== matrix;
}

function isSafeWorkspacePath(root: string, pathValue: string): boolean {
  if (!pathValue || pathValue.includes('\0') || isAbsolute(pathValue)) return false;
  const rootPath = resolve(root);
  const target = resolve(rootPath, pathValue);
  const rel = relative(rootPath, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Re-check canonical parents immediately before dispatch, including output paths that do not exist yet. */
async function isSafeOfficeTarget(root: string, pathValue: string): Promise<boolean> {
  const rootPath = await canonicalPath(root);
  const candidate = resolve(rootPath, pathValue);
  let probe = candidate;
  while (true) {
    try {
      const canonicalProbe = await realpath(probe);
      const canonicalCandidate = resolve(canonicalProbe, relative(probe, candidate));
      return isWithinRoot(rootPath, canonicalCandidate);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

async function canonicalPath(pathValue: string): Promise<string> {
  let probe = resolve(pathValue);
  while (true) {
    try {
      const canonicalProbe = await realpath(probe);
      return resolve(canonicalProbe, relative(probe, resolve(pathValue)));
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return resolve(pathValue);
      probe = parent;
    }
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeArtifact(value: unknown, workspaceId: string, runId: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const artifact = value as Record<string, unknown>;
  const path = typeof artifact.path === 'string' ? artifact.path : undefined;
  if (!path || path.includes('\0') || path.startsWith('/') || path.split(/[\\/]/).includes('..')) return undefined;
  return {
    ...artifact,
    uri: `workspace://${workspaceId}/${path}`,
    sourceRunId: typeof artifact.sourceRunId === 'string' ? artifact.sourceRunId : runId,
  };
}

function isOfficeReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.profile === 'string' && receipt.profile.startsWith('office.') && receipt.artifact !== undefined;
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function allChecksPassed(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const checks = value as Record<string, unknown>;
  return keys.every((key) => checks[key] === 'passed');
}

function hasUnknownCheck(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((status) => status === 'unknown' || status === 'conflict');
}

function unknownOffice(message: string, artifact?: Record<string, unknown>): Verification {
  return {
    result: 'unknown',
    verifier: 'office-v1',
    evidence: artifact?.uri && isSha256(artifact.hash) ? [{ type: 'office-artifact', summary: message, uri: String(artifact.uri), hash: String(artifact.hash) }] : [],
    message,
  };
}

function failedOffice(error: string): { ok: false; error: string; receipt: Record<string, unknown> } {
  return { ok: false, error, receipt: { worker: 'document-worker', sideEffect: 'none' } };
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]').slice(0, 500);
}

function workerEnvironment(configured: NodeJS.ProcessEnv | undefined, workspaceRoot: string): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'LANG', 'LC_ALL', 'PYTHONIOENCODING']);
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HELM_WORKSPACE_ROOT: workspaceRoot };
  for (const [key, value] of Object.entries(configured ?? {})) {
    if (allowed.has(key) && value !== undefined) environment[key] = value;
  }
  environment.PYTHONIOENCODING ??= 'utf-8';
  return environment;
}
