/**
 * CRON TOOL — scheduled task execution.
 *
 * Tool name matches Hermes: cronjob.
 * Manages scheduled tasks that run at specified intervals or one-shot times.
 *
 * Actions:
 *   create — schedule a new task (returns job_id)
 *   list   — show all scheduled jobs
 *   run    — trigger a job immediately
 *   pause  — pause a job
 *   resume — resume a paused job
 *   remove — delete a job
 */

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

interface ScheduledJob {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, ScheduledJob>();
let jobCounter = 0;

function parseSchedule(schedule: string): number {
  // Parse "30m", "2h", "1d" into milliseconds
  const match = schedule.match(/^(\d+)([mhd])$/);
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
  if (!isNaN(ts)) return ts - Date.now();
  // Default: 1 hour
  return 60 * 60 * 1000;
}

function scheduleNext(job: ScheduledJob, execute: (job: ScheduledJob) => Promise<void>): void {
  if (job.status !== 'active') return;
  const delay = parseSchedule(job.schedule);
  job.nextRunAt = Date.now() + delay;
  job.timer = setTimeout(async () => {
    await execute(job);
    job.runCount++;
    job.lastRunAt = Date.now();
    if (job.status === 'active') {
      scheduleNext(job, execute);
    }
  }, delay);
}

export function createCronToolHandlers(
  execute: (prompt: string) => Promise<string>,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  async function executeJob(job: ScheduledJob): Promise<void> {
    try {
      job.status = 'active';
      await execute(job.prompt);
    } catch {
      job.status = 'failed';
    }
  }

  handlers.set('cronjob', async (args): Promise<ToolResult> => {
    const action = args.action as string;

    switch (action) {
      case 'create': {
        const prompt = args.prompt as string;
        const schedule = (args.schedule as string) ?? '1h';
        const name = (args.name as string) ?? `job-${++jobCounter}`;
        const id = `cron-${Date.now()}-${jobCounter}`;

        const job: ScheduledJob = {
          id,
          name,
          prompt,
          schedule,
          status: 'active',
          createdAt: Date.now(),
          lastRunAt: null,
          nextRunAt: null,
          runCount: 0,
          timer: null,
        };

        jobs.set(id, job);
        scheduleNext(job, executeJob);

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
        job.runCount++;
        job.lastRunAt = Date.now();
        return { ok: true, output: `Job "${job.name}" executed.` };
      }

      case 'pause': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        job.status = 'paused';
        if (job.timer) clearTimeout(job.timer);
        job.timer = null;
        return { ok: true, output: `Job "${job.name}" paused.` };
      }

      case 'resume': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        job.status = 'active';
        scheduleNext(job, executeJob);
        return { ok: true, output: `Job "${job.name}" resumed.` };
      }

      case 'remove': {
        const job = jobs.get(args.job_id as string);
        if (!job) return { ok: false, output: '', error: `Job ${args.job_id} not found` };
        if (job.timer) clearTimeout(job.timer);
        jobs.delete(args.job_id as string);
        return { ok: true, output: `Job "${job.name}" removed.` };
      }

      default:
        return { ok: false, output: '', error: `Unknown action: ${action}` };
    }
  });

  return handlers;
}
