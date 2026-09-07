/**
 * PHONE TOOLS — a governed Android body (Termux + Termux:API).
 *
 * Provides a runtime with camera, microphone, sensors, GPS, battery/thermal, speech,
 * notifications, torch, and fast on-device OCR without needing to wake ikbi. When
 * When an agent runs on the phone, these are how it perceives and
 * acts through the device.
 *
 * EXECUTION: each tool shells a single fixed `termux-*` binary with ARRAY args (no
 * shell metacharacters) through an injectable runner. The default runner uses
 * spawnSync with a Termux-aware env — the phone's `termux-api` helper shells to
 * Android `am`, which needs the ANDROID_* / TERMUX_* / BOOTCLASSPATH / PREFIX / LD_PRELOAD vars; the
 * lab's other tools build env FROM EMPTY, which strips exactly those, so we pass the
 * Termux/Android vars through (extendable via AGENT_PHONE_ENV_ALLOWLIST). Off the
 * phone the termux-* binaries are absent, so every tool returns a clean "not found"
 * error rather than doing anything.
 *
 * CONFINEMENT: capture tools write ONLY inside the workspace (resolveInWorkspace); a
 * saved photo is then perceived with vision_analyze, closing the perceive→reason loop.
 *
 * TRANSPORT: LOCAL by default. Set AGENT_PHONE_SSH_HOST to drive
 * a REMOTE phone over SSH from a development host — the remote login
 * shell word-splits the joined command, so remote save paths must be space-free (the
 * LOCAL path is fully quote-safe via array args).
 *
 * TRUST: all device output (sensor JSON, OCR'd text, a location fix) is UNTRUSTED — the
 * core loop re-neutralizes every tool result at the injection chokepoint. This module
 * only PRODUCES result strings; it never builds a message and never throws past the loop.
 */
import { spawnSync } from 'node:child_process';
import { processScratchDir } from '../temp-authority.js';
import { mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';

import type { ToolSpec, ToolHandler, ToolResult, ToolContext } from '../tools.js';
import { resolveInWorkspace, ToolError } from '../workspace.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

// ── bounds + defaults ───────────────────────────────────────────────────────────
const DEFAULT_PHOTO_PATH = 'phone-captures/photo.jpg';
const DEFAULT_AUDIO_PATH = 'phone-captures/audio.m4a';
const DEFAULT_RECORD_SECONDS = 10;
const MIN_RECORD_SECONDS = 1;
const MAX_RECORD_SECONDS = 300;
const DEFAULT_SENSOR_SAMPLES = 1;
const MAX_SENSOR_SAMPLES = 20;

const PHONE_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

// ── transport + runner (the injection seam for tests) ─────────────────────────────

/** How a phone command reaches the device: local on-device execution or SSH. */
export type PhoneTransport = { readonly kind: 'local' } | { readonly kind: 'ssh'; readonly host: string };

/** The raw outcome of one device command. `error` is set for spawn failures (e.g. binary not found). */
export interface PhoneRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

/** Runs one termux binary with array args and returns its outcome. Injectable so tests need no device. */
export type PhoneRunner = (binary: string, args: readonly string[]) => PhoneRunResult;

/**
 * Resolve transport from the generic deployment environment. Unset means local/on-device.
 */
export function resolvePhoneTransport(env: NodeJS.ProcessEnv = process.env): PhoneTransport {
  const host = typeof env.AGENT_PHONE_SSH_HOST === 'string' ? env.AGENT_PHONE_SSH_HOST.trim() : '';
  return host.length > 0 ? { kind: 'ssh', host } : { kind: 'local' };
}

/** Env keys the termux-api → Android `am` bridge needs; scrubbed away by from-empty env builders otherwise. */
const TERMUX_ENV_KEYS: readonly string[] = [
  'BOOTCLASSPATH', 'DEX2OATBOOTCLASSPATH', 'PREFIX', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'ANDROID_ART_ROOT', 'ANDROID_I18N_ROOT', 'ANDROID_RUNTIME_ROOT', 'ANDROID_TZDATA_ROOT',
  'EXTERNAL_STORAGE', 'COLORTERM',
];
const TERMUX_ENV_PREFIXES: readonly string[] = ['ANDROID_', 'TERMUX_'];

/**
 * Build the env for a LOCAL termux command: PATH/HOME/LANG/TMPDIR plus the Termux/Android
 * vars the api bridge needs. AGENT_PHONE_ENV_ALLOWLIST (comma-separated) adds keys.
 * Carries NO secrets by construction — only device/OS wiring, never API keys/tokens.
 */
export function buildPhoneEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: src.PATH ?? '/data/data/com.termux/files/usr/bin:/usr/bin:/bin',
    HOME: src.HOME ?? '/data/data/com.termux/files/home',
    LANG: src.LANG ?? 'C.UTF-8',
  };
  // Temp dirs are never inherited: a lab-owned child always gets governed scratch.
  const scratch = processScratchDir();
  env.TMPDIR = scratch;
  env.TMP = scratch;
  env.TEMP = scratch;
  const extra = (src.AGENT_PHONE_ENV_ALLOWLIST ?? '')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== 'string') continue;
    if (TERMUX_ENV_KEYS.includes(k) || TERMUX_ENV_PREFIXES.some((p) => k.startsWith(p)) || extra.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

function capOutput(s: string): string {
  return s.length > MAX_OUTPUT_BYTES ? `${s.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]` : s;
}

/** The default on-device/ssh runner (spawnSync). Overridable in createPhoneToolHandlers for tests. */
export function defaultPhoneRunner(transport: PhoneTransport): PhoneRunner {
  return (binary, args) => {
    const isSsh = transport.kind === 'ssh';
    const cmd = isSsh ? 'ssh' : binary;
    const cmdArgs = isSsh ? [transport.host, binary, ...args] : [...args];
    // LOCAL: Termux-aware env. SSH: inherit process.env so ssh finds keys/known_hosts.
    const res = spawnSync(cmd, cmdArgs, {
      /*
        A BUILT environment. The device helper takes a fixed argv and cannot be asked to print what
        it holds, but the service environment carries CREDENTIALS_DIRECTORY — a path to the provider
        secret — and a phone helper has no reason to receive it. Termux needs its own PREFIX and
        HOME, which are supplied explicitly rather than inherited wholesale.
      */
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/home/zen',
        LANG: 'C.UTF-8',
        ...(process.env['PREFIX'] !== undefined ? { PREFIX: process.env['PREFIX'] } : {}),
        ...(process.env['ANDROID_DATA'] !== undefined ? { ANDROID_DATA: process.env['ANDROID_DATA'] } : {}),
      } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: PHONE_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      ...(isSsh ? {} : { env: buildPhoneEnv() }),
    });
    if (res.error !== undefined && res.error !== null) {
      const code = (res.error as NodeJS.ErrnoException).code;
      const msg = code === 'ENOENT'
          ? `${cmd} not found — is the agent running on a phone with Termux:API installed?`
        : res.error.message;
      return { code: -1, stdout: '', stderr: '', error: msg };
    }
    return { code: res.status ?? -1, stdout: capOutput(res.stdout ?? ''), stderr: capOutput(res.stderr ?? '') };
  };
}

// ── arg coercion + result rendering ───────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(hi, Math.max(lo, n));
}
const okR = (output: string): ToolResult => ({ ok: true, output });
const failR = (msg: string): ToolResult => ({ ok: false, output: msg, error: msg });

/** Confine a capture path to the workspace and pre-create its parent dir. */
function confineCapture(ctx: ToolContext, p: string): { full: string; rel: string } | { error: string } {
  let full: string;
  try {
    full = resolveInWorkspace(ctx.workspaceRoot, p);
  } catch (e) {
    return { error: e instanceof ToolError ? e.message : String(e) };
  }
  try {
    mkdirSync(dirname(full), { recursive: true });
  } catch {
    /* best-effort; the device command reports the real failure */
  }
  return { full, rel: relative(ctx.workspaceRoot, full) };
}

/** Render a device outcome into a ToolResult. `includeStdout` folds the command's stdout into a read. */
function render(r: PhoneRunResult, successMsg: string, includeStdout = false): ToolResult {
  if (r.error !== undefined) return failR(`phone command failed: ${r.error}`);
  if (r.code !== 0) {
    const err = r.stderr.trim().length > 0 ? `: ${r.stderr.trim()}` : '';
    return failR(`phone command exited ${r.code}${err} — is Termux:API installed and the permission granted for this capability?`);
  }
  if (includeStdout && r.stdout.trim().length > 0) return okR(`${successMsg}\n${r.stdout.trim()}`);
  return okR(successMsg);
}

// ── specs ─────────────────────────────────────────────────────────────────────────

export const phoneToolSpecs: ToolSpec[] = [
  {
    name: 'phone_take_photo',
    description:
      "Take a photo with the phone's camera (Termux:API). Saved into the workspace; then call vision_analyze with the returned path to SEE it. Choose the lens with `lens`.",
    parameters: obj({
      lens: { type: 'string', description: "'back' (default) or 'front'." },
      save_path: { type: 'string', description: `Workspace-relative path for the JPEG. Default '${DEFAULT_PHOTO_PATH}'.` },
    }, []),
  },
  {
    name: 'phone_record_audio',
    description:
      "Record audio from the phone's microphone for a fixed number of seconds (Termux:API). Time-limited; the file completes after the limit elapses. Returns the saved path.",
    parameters: obj({
      seconds: { type: 'number', description: `Length in seconds (${MIN_RECORD_SECONDS}-${MAX_RECORD_SECONDS}, default ${DEFAULT_RECORD_SECONDS}).` },
      save_path: { type: 'string', description: `Workspace-relative path for the audio. Default '${DEFAULT_AUDIO_PATH}'.` },
    }, []),
  },
  {
    name: 'phone_read_sensor',
    description:
      "Read a hardware sensor (accelerometer, gyroscope, light, proximity, magnetometer, …) via Termux:API and return its JSON values. Pass sensor='list' (or omit) to enumerate available sensors.",
    parameters: obj({
      sensor: { type: 'string', description: "Sensor name to read, or 'list' to enumerate." },
      samples: { type: 'number', description: `Readings to take before stopping (1-${MAX_SENSOR_SAMPLES}, default ${DEFAULT_SENSOR_SAMPLES}).` },
    }, []),
  },
  {
    name: 'phone_read_text',
    description:
      'Extract text from an image using FAST on-device OCR (tesseract). Best for SCREENSHOTS, documents, receipts — far faster/cheaper than vision_analyze. Give a workspace-relative image path. Returns the recognized text.',
    parameters: obj({
      path: { type: 'string', description: "Workspace-relative path to the image (e.g. 'phone-captures/screenshot.png')." },
    }, ['path']),
  },
  {
    name: 'phone_location',
    description: "Get the phone's current location (GPS/network) via Termux:API and return the JSON fix (latitude, longitude, accuracy, …).",
    parameters: obj({
      provider: { type: 'string', description: "'gps' (default), 'network', or 'passive'." },
    }, []),
  },
  {
    name: 'phone_battery',
    description: "Read the phone's battery + thermal status (percentage, charging state, temperature, health) via Termux:API. Returns JSON for device-health monitoring.",
    parameters: obj({}, []),
  },
  {
    name: 'phone_speak',
    description: "Speak text aloud through the phone's speaker (Termux:API text-to-speech).",
    parameters: obj({
      text: { type: 'string', description: 'The text to speak.' },
    }, ['text']),
  },
  {
    name: 'phone_notify',
    description: 'Post an Android notification on the phone (Termux:API). Use to surface something to the human holding the device.',
    parameters: obj({
      content: { type: 'string', description: 'The notification body.' },
      title: { type: 'string', description: "The notification title. Default 'Agent'." },
    }, ['content']),
  },
  {
    name: 'phone_torch',
    description: "Turn the phone's camera flashlight (torch) on or off via Termux:API.",
    parameters: obj({
      on: { type: 'boolean', description: 'true to turn the torch ON (default), false to turn it OFF.' },
    }, []),
  },
];

/** The set of phone tool names — for allowlist/dispatch checks. */
export const phoneToolNames: ReadonlySet<string> = new Set(phoneToolSpecs.map((s) => s.name));

// ── handlers ────────────────────────────────────────────────────────────────────

export interface PhoneToolOptions {
  /** Override the device runner (tests inject a fake). Defaults to the spawnSync runner for the transport. */
  readonly run?: PhoneRunner;
  /** Override the transport. Defaults to resolvePhoneTransport(process.env). */
  readonly transport?: PhoneTransport;
}

export function createPhoneToolHandlers(opts: PhoneToolOptions = {}): Map<string, ToolHandler> {
  const transport = opts.transport ?? resolvePhoneTransport();
  const run: PhoneRunner = opts.run ?? defaultPhoneRunner(transport);
  const handlers = new Map<string, ToolHandler>();

  handlers.set('phone_take_photo', async (args, ctx): Promise<ToolResult> => {
    const lens = str(args.lens) === 'front' ? 'front' : 'back';
    const cameraId = lens === 'front' ? '1' : '0';
    const c = confineCapture(ctx, str(args.save_path) || DEFAULT_PHOTO_PATH);
    if ('error' in c) return failR(c.error);
    const r = run('termux-camera-photo', ['-c', cameraId, c.full]);
    return render(r, `Saved photo (lens=${lens}) to ${c.rel}. Use vision_analyze with image path "${c.rel}" to see it.`);
  });

  handlers.set('phone_record_audio', async (args, ctx): Promise<ToolResult> => {
    const seconds = clampInt(args.seconds, DEFAULT_RECORD_SECONDS, MIN_RECORD_SECONDS, MAX_RECORD_SECONDS);
    const c = confineCapture(ctx, str(args.save_path) || DEFAULT_AUDIO_PATH);
    if ('error' in c) return failR(c.error);
    const r = run('termux-microphone-record', ['-l', String(seconds), '-f', c.full]);
    return render(r, `Recording ~${seconds}s of audio to ${c.rel}. The file completes after the limit elapses — read or transcribe it after that.`);
  });

  handlers.set('phone_read_sensor', async (args): Promise<ToolResult> => {
    const sensor = str(args.sensor);
    if (sensor === '' || sensor.toLowerCase() === 'list') {
      return render(run('termux-sensor', ['-l']), 'Available sensors:', true);
    }
    const samples = clampInt(args.samples, DEFAULT_SENSOR_SAMPLES, 1, MAX_SENSOR_SAMPLES);
    const r = run('termux-sensor', ['-s', sensor, '-n', String(samples)]);
    return render(r, `Sensor '${sensor}' (${samples} sample${samples === 1 ? '' : 's'}):`, true);
  });

  handlers.set('phone_read_text', async (args, ctx): Promise<ToolResult> => {
    const p = str(args.path);
    if (p === '') return failR("phone_read_text requires a non-empty 'path'");
    let full: string;
    try {
      full = resolveInWorkspace(ctx.workspaceRoot, p);
    } catch (e) {
      return failR(e instanceof ToolError ? e.message : String(e));
    }
    const rel = relative(ctx.workspaceRoot, full);
    // OCR'd text is UNTRUSTED (an image can carry adversarial text) → the loop re-neutralizes it.
    return render(run('tesseract', [full, 'stdout']), `Text extracted from ${rel}:`, true);
  });

  handlers.set('phone_location', async (args): Promise<ToolResult> => {
    const raw = str(args.provider).toLowerCase();
    const provider = raw === 'network' || raw === 'passive' ? raw : 'gps';
    return render(run('termux-location', ['-p', provider]), `Location (provider=${provider}):`, true);
  });

  handlers.set('phone_battery', async (): Promise<ToolResult> => {
    return render(run('termux-battery-status', []), 'Battery/thermal status:', true);
  });

  handlers.set('phone_speak', async (args): Promise<ToolResult> => {
    const text = str(args.text);
    if (text === '') return failR("phone_speak requires non-empty 'text'");
    const r = run('termux-tts-speak', [text]);
    return render(r, `Spoke: "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`);
  });

  handlers.set('phone_notify', async (args): Promise<ToolResult> => {
    const content = str(args.content);
    if (content === '') return failR("phone_notify requires non-empty 'content'");
    const title = str(args.title) || 'Agent';
    const r = run('termux-notification', ['--title', title, '--content', content]);
    return render(r, `Posted notification "${title}".`);
  });

  handlers.set('phone_torch', async (args): Promise<ToolResult> => {
    const on = args.on !== false; // default ON
    const r = run('termux-torch', [on ? 'on' : 'off']);
    return render(r, `Torch ${on ? 'ON' : 'OFF'}.`);
  });

  return handlers;
}
