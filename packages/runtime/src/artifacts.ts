import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { ArtifactReference, ArtifactStore, ID } from './types.js';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Small local artifact store used by tool adapters for large outputs. */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly root: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  async put(input: { runId: ID; type: string; content: string | Uint8Array; extension?: string; path?: string; limitations?: string[] }): Promise<ArtifactReference> {
    const bytes = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : input.content;
    if (bytes.byteLength > this.maxBytes) throw new Error('Artifact exceeds the configured size bound.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const extension = sanitizeExtension(input.extension ?? extensionForType(input.type));
    const relativePath = `${sanitizeSegment(input.runId)}/${hash}${extension ? `.${extension}` : ''}`;
    const target = resolve(this.root, relativePath);
    await mkdir(resolve(this.root, sanitizeSegment(input.runId)), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' }).catch(async (error: unknown) => {
      if ((error as { code?: string })?.code !== 'EEXIST') throw error;
    });
    return {
      uri: `artifact://${encodeURIComponent(input.runId)}/${hash}${extension ? `.${extension}` : ''}`,
      type: input.type,
      hash,
      bytes: bytes.byteLength,
      sourceRunId: input.runId,
      path: input.path,
      limitations: input.limitations,
    };
  }

  async read(uri: string): Promise<Uint8Array> {
    const match = /^artifact:\/\/([^/]+)\/([a-f0-9]{64}(?:\.[a-z0-9_-]+)?)$/i.exec(uri);
    if (!match) throw new Error('Invalid artifact URI.');
    const runId = decodeURIComponent(match[1]);
    const filename = basename(match[2]);
    const bytes = await readFile(resolve(this.root, sanitizeSegment(runId), filename));
    if (bytes.byteLength > this.maxBytes) throw new Error('Artifact exceeds the configured size bound.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!filename.startsWith(hash)) throw new Error('Artifact hash does not match its content.');
    return bytes;
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly values = new Map<string, Uint8Array>();

  async put(input: { runId: ID; type: string; content: string | Uint8Array; extension?: string; path?: string; limitations?: string[] }): Promise<ArtifactReference> {
    const bytes = typeof input.content === 'string' ? new TextEncoder().encode(input.content) : new Uint8Array(input.content);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const uri = `artifact://${encodeURIComponent(input.runId)}/${hash}`;
    this.values.set(uri, bytes);
    return { uri, type: input.type, hash, bytes: bytes.byteLength, sourceRunId: input.runId, path: input.path, limitations: input.limitations };
  }

  async read(uri: string): Promise<Uint8Array> {
    const value = this.values.get(uri);
    if (!value) throw new Error('Unknown artifact URI.');
    return new Uint8Array(value);
  }
}

function sanitizeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!segment || segment === '.' || segment === '..') throw new Error('Invalid artifact path segment.');
  return segment.slice(0, 120);
}

function sanitizeExtension(value: string): string {
  return value.replace(/^\./, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
}

function extensionForType(type: string): string {
  const value = type.toLowerCase();
  if (value.includes('json')) return 'json';
  if (value.includes('text') || value.includes('diff')) return 'txt';
  return '';
}
