/**
 * CRON TOOL — scheduled task execution (Blocker 3: real execution + persistence).
 *
 * Tool name matches Hermes: cronjob.
 * Manages scheduled tasks that run at specified intervals or one-shot times.
 *
 * Two production gaps this closes:
 *   1. The `execute` callback now runs a REAL agent loop (wired in index.ts), not a
 *      stub that returns a string without doing anything.
 *   2. Jobs are PERSISTED to a JSON file and RELOADED on startup, so a schedule
 *      survives a process restart instead of living only in memory.
 *
 * Actions:
 *   create — schedule a new task (returns job_id)
 *   list   — show all scheduled jobs
 *   run    — trigger a job immediately
 *   pause  — pause a job
 *   resume — resume a paused job
 *   remove — delete a job
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const cronToolSpecs: ToolSpec[] = [
  {
    name: 'cronjob',
    description: 'Manage scheduled tasks. Actions: create (schedule a task), list (show jobs), run (trigger now), pause, resume, remove.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['create', 'list', 'run', 'pause', 'resume', 'remove'], description: 'Action to perform' },
        prompt: { type: 'string', description: 'Task prompt (for create)' },
        schedule: { type: 'string', description: 'Schedule: "30m", "every 2h", "0 9 * * *" (cron), or ISO timestamp for one-shot' },
        name: { type: 'string', description: 'Human-friendly job name' },
        job_id: { type: 'string', description: 'Job ID (for run/pause/resume/remove)' },
      },
      ['action'],
    ),
  },
];

export interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  /** Last result text from the executed agent loop (truncated). Not persisted-critical. */
  lastResult?: string;
  /** Live timer — NEVER persisted (not serializable). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** The persisted shape of a job (everything except the live timer). */
type PersistedJob = Omit<ScheduledJob, 'timer'>;

export interface CronOptions {
  /** Path to the JSON file jobs are persisted to / reloaded from. Unset => in-memory only. */
  readonly persistPath?: string;
  /** Injectable clock for deterministic timestamps in tests. */
  readonly clock?: () => number;
  /**
   * When false (the default in tests), persisted jobs are reloaded but NOT armed with
   * live timers — so a test can assert reload happened without a background timer
   * firing. Production passes true so reloaded active jobs resume on their schedule.
   */
  readonly rearmOnLoad?: boolean;
}

const INTERVAL_RE = /^(\d+)([mhd])$/;

function parseSchedule(schedule: string, now: number): number {
  // Parse "30m", "2h", "1d" into milliseconds
  const match = schedule.match(INTERVAL_RE);
  if (match) {
    const n = parseInt(match[1]!, 10);
    const unit = match[2];
    switch (unit) {
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      case 'd': return n * 24 * 60 * 60 * 1000;
    }
  }
  // Try ISO timestamp
  const ts = new Date(schedule).getTime();
  if (!isNaN(ts)) return Math.max(0, ts - now);
  // Default: 1 hour
  return 60 * 60 * 1000;
}

/**
 * A one-shot schedule is a concrete ISO timestamp, not a recurring interval. H7: a
 * one-shot job fires ONCE; after it runs it must be marked completed and never
 * rescheduled. Previously scheduleNext re-armed it with the SAME past timestamp, whose
 * delay clamps to 0 — an unbounded, instantaneous refire loop.
 */
function isOneShot(schedule: string): boolean {
  if (INTERVAL_RE.test(schedule)) return false; // "30m"/"2h"/"1d" recur
  return !isNaN(new Date(schedule).getTime()); // a parseable date => one-shot
}

export function createCronToolHandlers(
  execute: (prompt: string) => Promise<string>,
  options: CronOptions = {},
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const clock = options.clock ?? Date.now;
  // Per-instance state — no module-level leakage across registries/tests.
  const jobs = new Map<string, ScheduledJob>();
  let jobCounter = 0;

  const persist = (): void => {
    if (options.persistPath === undefined) return;
    const dir = dirname(options.persistPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const list: PersistedJob[] = Array.from(jobs.values()).map(({ timer: _timer, ...rest }) => rest);
    writeFileSync(options.persistPath, JSON.stringify(list, null, 2));
  };

  const scheduleNext = (job: ScheduledJob): void => {
    if (job.status !== 'active') return;
    const delay = parseSchedule(job.schedule, clock());
    job.nextRunAt = clock() + delay;
    job.timer = setTimeout(async () => {
      await executeJob(job);
      // H7: a one-shot (ISO timestamp) job fires exactly once. Mark it completed and
      // do NOT reschedule — re-arming with the same past timestamp would refire forever.
      if (isOneShot(job.schedule)) {
        if (job.status === 'active') job.status = 'completed';
        job.nextRunAt = null;
        job.timer = null;
        persist();
        return;
      }
      if (job.status === 'active') scheduleNext(job);
    }, delay);
    // Don't keep the event loop alive solely for a scheduled job.
    job.timer.unref?.();
  };

  async function executeJob(job: ScheduledJob): Promise<void> {
    try {
      // A one-shot mid-run stays 'active'; the caller transitions it to 'completed'
      // after this resolves. A recurring job is (re)affirmed active while it runs.
      if (job.status !== 'completed') job.status = 'active';
      const result = await execute(job.prompt);
      job.lastResult = result.slice(0, 500);
      job.runCount++;
      job.lastRunAt = clock();
    } catch (err) {
      job.status = 'failed';
      job.lastResult = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    persist();
  }

  // ── RELOAD persisted jobs on startup ────────────────────────────────────────
  if (options.persistPath !== undefined && existsSync(options.persistPath)) {
    try {
      const raw = readFileSync(options.persistPath, 'utf-8');
      const list = JSON.parse(raw) as PersistedJob[];
      for (const pj of list) {
        const job: ScheduledJob = { ...pj, timer: null };
        jobs.set(job.id, job);
        // Re-arm only active jobs, and only when asked (production), so a reload in a
        // test does not spawn a live background timer.
        if (job.status === 'active' && options.rearmOnLoad === true) scheduleNext(job);
      }
    } catch {
      // A corrupt store is non-fatal: start empty rather than crash on boot.
    }
  }

  handlers.set('cronjob', async (args): Promise<ToolResult> => {
    const action = args.action as string;

    switch (action) {
      case 'create': {
        const prompt = args.prompt as string;
        const schedule = (args.schedule as string) ?? '1h';
        const name = (args.name as string) ?? `job-${++jobCounter}`;
        const id = `cron-${clock()}-${++jobCounter}`;

        const job: ScheduledJob = {
          id,
          name,
          prompt,
          schedule,
          status: 'active',
          createdAt: clock(),
          lastRunAt: null,
          nextRunAt: null,
          runCount: 0,
          timer: null,
        };

        jobs.set(id, job);
        scheduleNext(job);
        persist();

        return {
          ok: true,
          output: `Scheduled job "${name}" (${id}): "${prompt.slice(0, 100)}" every ${schedule}`,
        };
      }

      case 'list': {
        const list = Array.from(jobs.values()).map(j => ({
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          status: j.status,
          runCount: j.runCount,
          lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          nextRunAt: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
        }));
        return {
          ok: true,
          output: list.length > 0
            ? JSON.stringify(list, null, 2)
            : 'No scheduled jobs.',
        };
      }

      case 'run': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        await executeJob(job);
        return { ok: true, output: `Job "${job.name}" executed.\n${job.lastResult ?? ''}` };
      }

      case 'pause': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        job.status = 'paused';
        if (job.timer) clearTimeout(job.timer);
        job.timer = null;
        persist();
        return { ok: true, output: `Job "${job.name}" paused.` };
      }

      case 'resume': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        job.status = 'active';
        scheduleNext(job);
        persist();
        return { ok: true, output: `Job "${job.name}" resumed.` };
      }

      case 'remove': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        if (job.timer) clearTimeout(job.timer);
        jobs.delete(args.job_id as string);
        persist();
        return { ok: true, output: `Job "${job.name}" removed.` };
      }

      default:
        return { ok: false, output: '', error: `Unknown action: ${action}` };
    }
  });

  return handlers;
}
