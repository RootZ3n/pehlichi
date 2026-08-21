import type { TerminalReceipt, ToolResult } from '../tools.js';
import { guardToolOutput } from './velum-scan.js';
import {
  quarantineSummary,
  type RestrictedEvidenceMetadata,
  type RestrictedEvidenceRecorder,
  type ToolTextChannel,
} from './restricted-evidence.js';

export interface GuardedToolResult {
  readonly result: ToolResult;
  readonly findings: readonly RestrictedEvidenceMetadata[];
}

const RESULT_KEYS = new Set(['diff', 'error', 'ok', 'output', 'receipt', 'skillCreated']);
const DIFF_KEYS = ['after', 'before', 'path'] as const;
const SKILL_KEYS = ['name', 'type'] as const;
const RECEIPT_KEYS = [
  'command', 'cwd', 'durationMs', 'envKeys', 'exitCode', 'stderrBytes',
  'stdoutBytes', 'truncated',
] as const;

function plainDataRecord(value: unknown, expected: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has an unsafe prototype`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} has symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.some((key) => !expected.has(key))) throw new Error(`${label} has unexpected fields`);
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${label} has an accessor field`);
    record[key] = descriptor.value;
  }
  return record;
}

function exactRecord(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  const record = plainDataRecord(value, new Set(expected), label);
  const keys = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has missing fields`);
  }
  return record;
}

function safeStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) throw new Error(`${label} has invalid length`);
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'string') {
      throw new Error(`${label} contains a non-data string`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`);
  return value as number;
}

function safeThrownText(value: unknown): string {
  if (typeof value === 'string') return value || 'tool threw an empty string';
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return 'tool threw a non-text value';
  }
  try {
    if (typeof value !== 'object') return 'tool threw an unsupported value';
    const descriptor = Object.getOwnPropertyDescriptor(value, 'message');
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && typeof descriptor.value === 'string' && descriptor.value.length > 0
      ? descriptor.value
      : 'tool threw an object without a safe message';
  } catch {
    return 'tool threw an unreadable value';
  }
}

/** Convert arbitrary thrown values without invoking attacker-controlled coercion. */
export function thrownToolFailure(value: unknown): ToolResult {
  return Object.freeze({ ok: false, output: '', error: safeThrownText(value) });
}

/**
 * The sole projection boundary for every value originating at a tool handler.
 *
 * No source object is spread or serialized. Accessors, proxies, malformed
 * primitives, unexpected nested metadata, and unsafe prototypes become a fixed
 * deterministic failure without incorporating attacker-controlled error text.
 */
export function projectToolResult(
  source: string,
  input: unknown,
  recorder: RestrictedEvidenceRecorder,
): GuardedToolResult {
  try {
    const raw = plainDataRecord(input, RESULT_KEYS, 'tool result');
    if (typeof raw.ok !== 'boolean' || typeof raw.output !== 'string') throw new Error('tool result shape is invalid');
    if (raw.error !== undefined && typeof raw.error !== 'string') throw new Error('tool error is not text');
    const findings: RestrictedEvidenceMetadata[] = [];
    const project = (channel: ToolTextChannel, value: string): string => {
      if (value.length === 0) return '';
      const guarded = guardToolOutput(value, `${source}:${channel}`);
      if (!guarded.scan.detected) return guarded.safe;
      const finding = recorder.record(source, channel, value, guarded.scan.patterns);
      findings.push(finding);
      return quarantineSummary(finding);
    };
    // Structural metadata must remain machine-usable (for example, undo paths).
    // It is still scanned; hostile metadata is quarantined and the enclosing
    // mutable structure is omitted, while benign bytes remain exact.
    const projectMetadata = (value: string): string => {
      if (value.length === 0) return '';
      const guarded = guardToolOutput(value, `${source}:metadata`);
      if (!guarded.scan.detected) return value;
      const finding = recorder.record(source, 'metadata', value, guarded.scan.patterns);
      findings.push(finding);
      return quarantineSummary(finding);
    };

    const output = project('output', raw.output);
    const error = raw.error === undefined ? undefined : project('error', raw.error);
    let diff: ToolResult['diff'];
    if (raw.diff !== undefined) {
      const beforeFindings = findings.length;
      const value = exactRecord(raw.diff, DIFF_KEYS, 'tool diff');
      if (typeof value.path !== 'string' || (value.before !== null && typeof value.before !== 'string')
          || typeof value.after !== 'string') throw new Error('tool diff shape is invalid');
      const projected = {
        path: projectMetadata(value.path),
        before: value.before === null ? null : projectMetadata(value.before),
        after: projectMetadata(value.after),
      };
      // A quarantined diff cannot safely power the public undo journal.
      if (findings.length === beforeFindings) diff = Object.freeze(projected);
    }

    let receipt: TerminalReceipt | undefined;
    if (raw.receipt !== undefined) {
      const value = exactRecord(raw.receipt, RECEIPT_KEYS, 'terminal receipt');
      if (typeof value.command !== 'string' || typeof value.cwd !== 'string'
          || typeof value.truncated !== 'boolean' || !Number.isSafeInteger(value.exitCode)) {
        throw new Error('terminal receipt shape is invalid');
      }
      receipt = Object.freeze({
        command: projectMetadata(value.command),
        cwd: projectMetadata(value.cwd),
        envKeys: safeStringArray(value.envKeys, 'terminal receipt envKeys').map(projectMetadata),
        exitCode: value.exitCode as number,
        durationMs: nonNegativeSafeInteger(value.durationMs, 'terminal receipt durationMs'),
        stdoutBytes: nonNegativeSafeInteger(value.stdoutBytes, 'terminal receipt stdoutBytes'),
        stderrBytes: nonNegativeSafeInteger(value.stderrBytes, 'terminal receipt stderrBytes'),
        truncated: value.truncated,
      });
    }

    let skillCreated: ToolResult['skillCreated'];
    if (raw.skillCreated !== undefined) {
      const value = exactRecord(raw.skillCreated, SKILL_KEYS, 'skill-created metadata');
      if (typeof value.name !== 'string' || typeof value.type !== 'string') throw new Error('skill-created metadata is invalid');
      skillCreated = Object.freeze({
        name: projectMetadata(value.name),
        type: projectMetadata(value.type),
      });
    }

    return Object.freeze({
      result: Object.freeze({
        ok: raw.ok && findings.length === 0,
        output,
        ...(error !== undefined ? { error } : {}),
        ...(diff !== undefined ? { diff } : {}),
        ...(receipt !== undefined ? { receipt } : {}),
        ...(skillCreated !== undefined ? { skillCreated } : {}),
      }),
      findings: Object.freeze(findings),
    });
  } catch {
    return Object.freeze({
      result: Object.freeze({
        ok: false,
        output: '',
        error: 'tool returned malformed or unreadable data; unsafe details were withheld',
      }),
      findings: Object.freeze([]),
    });
  }
}
