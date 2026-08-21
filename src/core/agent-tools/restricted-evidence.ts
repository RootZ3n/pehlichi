import { createHash, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

export type ToolTextChannel = 'output' | 'error' | 'stderr' | 'partial' | 'metadata';

export interface EvidenceOwner {
  readonly taskId: string;
  readonly roomKey: string;
  readonly callerId?: string;
}

export interface RestrictedEvidenceMetadata {
  readonly id: string;
  readonly sha256: string;
  readonly source: string;
  readonly channel: ToolTextChannel;
  readonly patterns: readonly string[];
  readonly bytes: number;
  readonly recordedAt: number;
}

export interface PublicFindingMetadata {
  readonly evidenceId: string;
  readonly sha256: string;
  readonly source: string;
  readonly channel: ToolTextChannel;
  readonly patterns: readonly string[];
  readonly bytes: number;
}

interface RestrictedEvidence extends RestrictedEvidenceMetadata {
  readonly ownerKey: string;
  readonly expiresAt: number;
  readonly raw: string;
}

export interface RestrictedEvidenceRecorder {
  record(source: string, channel: ToolTextChannel, raw: string, patterns: readonly string[]): RestrictedEvidenceMetadata;
}

export interface RestrictedForensicAccess {
  get(owner: EvidenceOwner, id: string): (RestrictedEvidenceMetadata & { readonly raw: string }) | undefined;
  readonly size: number;
  readonly bytes: number;
  sweep(): number;
  clear(): void;
  destroy(): void;
}

export interface RestrictedEvidenceOptions {
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly cleanupIntervalMs?: number;
}

export interface RestrictedEvidenceVault {
  recorderFor(owner: EvidenceOwner): RestrictedEvidenceRecorder;
  /** Explicit restricted capability. Never return this from an ordinary runtime/server object. */
  readonly forensic: RestrictedForensicAccess;
}

const EVIDENCE_ID = /^velum-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE = /^[A-Za-z0-9_.:-]{1,256}$/;
const CHANNELS = new Set<ToolTextChannel>(['output', 'error', 'stderr', 'partial', 'metadata']);
const FINDING_KEYS = ['bytes', 'channel', 'evidenceId', 'patterns', 'sha256', 'source'] as const;

function ownerKey(owner: EvidenceOwner): string {
  if (typeof owner.taskId !== 'string' || owner.taskId.length === 0
      || typeof owner.roomKey !== 'string' || owner.roomKey.length === 0
      || (owner.callerId !== undefined && (typeof owner.callerId !== 'string' || owner.callerId.length === 0))) {
    throw new Error('restricted evidence owner is invalid');
  }
  return JSON.stringify([owner.taskId, owner.roomKey, owner.callerId ?? null]);
}

export function toPublicFinding(metadata: RestrictedEvidenceMetadata): PublicFindingMetadata {
  return Object.freeze({
    evidenceId: metadata.id,
    sha256: metadata.sha256,
    source: metadata.source,
    channel: metadata.channel,
    patterns: Object.freeze([...metadata.patterns]),
    bytes: metadata.bytes,
  });
}

export function validateFindingMetadata(value: unknown): PublicFindingMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('finding metadata must be an object');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== FINDING_KEYS.length || keys.some((key, index) => key !== FINDING_KEYS[index])) {
    throw new Error('finding metadata contains missing, unknown, or raw-evidence fields');
  }
  if (typeof record.evidenceId !== 'string' || !EVIDENCE_ID.test(record.evidenceId)
      || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)
      || typeof record.source !== 'string' || !SOURCE.test(record.source)
      || typeof record.channel !== 'string' || !CHANNELS.has(record.channel as ToolTextChannel)
      || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0
      || !Array.isArray(record.patterns) || record.patterns.length === 0
      || record.patterns.some((pattern) => typeof pattern !== 'string' || !SOURCE.test(pattern))
      || new Set(record.patterns).size !== record.patterns.length) {
    throw new Error('finding metadata is malformed');
  }
  return Object.freeze({
    evidenceId: record.evidenceId,
    sha256: record.sha256,
    source: record.source,
    channel: record.channel as ToolTextChannel,
    patterns: Object.freeze([...(record.patterns as string[])]),
    bytes: record.bytes as number,
  });
}

export function createRestrictedEvidenceVault(options: RestrictedEvidenceOptions = {}): RestrictedEvidenceVault {
  const clock = options.clock ?? Date.now;
  const ttlMs = options.ttlMs ?? 15 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 256;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.min(60_000, ttlMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs < 1) {
    throw new Error('restricted evidence retention limits are invalid');
  }

  const records = new Map<string, RestrictedEvidence>();
  let retainedBytes = 0;
  const remove = (id: string): boolean => {
    const record = records.get(id);
    if (!record) return false;
    records.delete(id);
    retainedBytes -= record.bytes;
    return true;
  };
  const sweep = (): number => {
    const before = records.size;
    const now = clock();
    for (const [id, record] of records) if (record.expiresAt <= now) remove(id);
    while (records.size > maxEntries || retainedBytes > maxBytes) {
      const oldest = records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      remove(oldest);
    }
    return before - records.size;
  };

  const timer = setInterval(sweep, cleanupIntervalMs);
  timer.unref();

  const forensic: RestrictedForensicAccess = {
    get(owner, id) {
      sweep();
      const record = records.get(id);
      if (!record || record.ownerKey !== ownerKey(owner)) return undefined;
      const { ownerKey: _owner, expiresAt: _expires, ...visible } = record;
      return Object.freeze({ ...visible, patterns: Object.freeze([...visible.patterns]) });
    },
    get size() { sweep(); return records.size; },
    get bytes() { sweep(); return retainedBytes; },
    sweep,
    clear() { records.clear(); retainedBytes = 0; },
    destroy() { clearInterval(timer); records.clear(); retainedBytes = 0; },
    [inspect.custom]() {
      return `RestrictedForensicAccess { entries: ${records.size}, bytes: ${retainedBytes}, raw: [RESTRICTED] }`;
    },
    toJSON() { return { entries: records.size, bytes: retainedBytes, raw: '[RESTRICTED]' }; },
  } as RestrictedForensicAccess;

  return Object.freeze({
    recorderFor(owner: EvidenceOwner): RestrictedEvidenceRecorder {
      const key = ownerKey(owner);
      return Object.freeze({
        record(source: string, channel: ToolTextChannel, raw: string, patterns: readonly string[]) {
          if (!SOURCE.test(source) || !CHANNELS.has(channel) || typeof raw !== 'string'
              || !Array.isArray(patterns) || patterns.length === 0
              || patterns.some((pattern) => typeof pattern !== 'string' || !SOURCE.test(pattern))) {
            throw new Error('restricted evidence record is invalid');
          }
          sweep();
          const bytes = Buffer.byteLength(raw);
          const record: RestrictedEvidence = Object.freeze({
            id: `velum-${randomUUID()}`,
            sha256: createHash('sha256').update(raw).digest('hex'),
            source,
            channel,
            patterns: Object.freeze([...new Set(patterns)]),
            bytes,
            recordedAt: clock(),
            expiresAt: clock() + ttlMs,
            ownerKey: key,
            raw,
          });
          records.set(record.id, record);
          retainedBytes += bytes;
          sweep();
          const { raw: _raw, ownerKey: _owner, expiresAt: _expires, ...metadata } = record;
          return Object.freeze({ ...metadata, patterns: Object.freeze([...metadata.patterns]) });
        },
      });
    },
    forensic,
  });
}

export function quarantineSummary(metadata: RestrictedEvidenceMetadata): string {
  return `[VELUM QUARANTINE: untrusted tool ${metadata.channel} withheld; evidence=${metadata.id}; sha256=${metadata.sha256}; patterns=${metadata.patterns.join(',')}]`;
}
