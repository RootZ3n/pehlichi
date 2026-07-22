/**
 * LUAK TOOLS — operate the Luak benchmark ground (model/provider registry + trials + leaderboard)
 * from Peh, over HTTP. Luak is the lab's AI-model benchmark scoreboard; these tools let Peh add and
 * change the models it tests, test provider connectivity, kick off trials, and read the leaderboard —
 * fully drivable from the phone.
 *
 * ENDPOINT: LUAK_API_URL if set, else http://<LAB_BRIDGE_HOST>:<LUAK_PORT|18795> — so the same
 * LAB_BRIDGE_HOST that points Peh's bridges at the lab (over Tailscale) also points these tools there.
 * Luak is lab-only / unauthenticated by design, so no token is sent.
 *
 * Read tools (luak_registry, luak_leaderboard) are side-effect-free; the mutating/costly ones
 * (add/update/remove model, add/test provider, run) are gated by the approval policy.
 */
import { bridgeHost } from '../bridges/host.js';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const LUAK_TIMEOUT_MS = 30_000;

/** Resolve the Luak base URL: LUAK_API_URL wins, else http://<bridgeHost>:<LUAK_PORT|18795>. */
function luakBaseUrl(): string {
  const explicit = process.env['LUAK_API_URL']?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit.replace(/\/+$/, '');
  const port = process.env['LUAK_PORT']?.trim() || '18795';
  return `http://${bridgeHost()}:${port}`;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** A JSON HTTP request to Luak, with timeout + uniform error mapping. */
async function luakRequest(
  tool: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = `${luakBaseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(LUAK_TIMEOUT_MS),
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error && err.name === 'TimeoutError'
      ? `no response within ${LUAK_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${tool}: cannot reach Luak at ${originOf(url)} (${detail}). Is Luak running / the lab reachable?` };
  }
  const text = await response.text().catch(() => '');
  let data: unknown;
  if (text.length > 0) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const msg = data !== null && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
      ? String((data as Record<string, unknown>).error)
      : typeof data === 'string' && data.length > 0 ? data : response.statusText;
    return { ok: false, error: `${tool}: Luak returned ${response.status} ${msg}`.trim() };
  }
  return { ok: true, data };
}

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function toResult(r: { ok: true; data: unknown } | { ok: false; error: string }): ToolResult {
  return r.ok ? { ok: true, output: JSON.stringify(r.data) } : { ok: false, output: '', error: r.error };
}
/** Collect the optional model/provider edit fields present in args. */
function editFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof args.displayName === 'string') out.displayName = args.displayName;
  if (typeof args.enabled === 'boolean') out.enabled = args.enabled;
  if (Array.isArray(args.tags)) out.tags = args.tags.filter((t): t is string => typeof t === 'string');
  if (typeof args.notes === 'string' || args.notes === null) out.notes = args.notes;
  return out;
}

export const luakToolSpecs: ToolSpec[] = [
  {
    name: 'luak_registry',
    description: 'View the Luak model/provider registry: configured providers, models, and the presets available to add new providers. Read-only. Use this first to get provider config ids + model ids.',
    parameters: obj({}, []),
  },
  {
    name: 'luak_add_model',
    description: 'Add a model to a provider in Luak so it gets benchmarked. Needs the providerConfigId (from luak_registry) and the modelId (the provider\'s model name).',
    parameters: obj({
      providerConfigId: { type: 'string', description: 'The provider config id to attach the model to (see luak_registry).' },
      modelId: { type: 'string', description: "The provider's model id/name, e.g. 'deepseek-v4-flash'." },
      displayName: { type: 'string', description: 'Human-friendly name (optional).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      notes: { type: 'string', description: 'Optional notes.' },
      enabled: { type: 'boolean', description: 'Enabled for benchmarking (default true).' },
    }, ['providerConfigId', 'modelId']),
  },
  {
    name: 'luak_update_model',
    description: "Change an existing Luak model: enable/disable it, rename, retag, or edit notes. Needs the model's registry id (the 'id' like mdl-... from luak_registry).",
    parameters: obj({
      id: { type: 'string', description: "The model's registry id (mdl-…) from luak_registry." },
      displayName: { type: 'string', description: 'New display name.' },
      enabled: { type: 'boolean', description: 'Enable/disable benchmarking of this model.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replace tags.' },
      notes: { type: 'string', description: 'Set/clear notes.' },
    }, ['id']),
  },
  {
    name: 'luak_remove_model',
    description: "Remove a model from Luak's registry. Needs the model's registry id (mdl-…).",
    parameters: obj({ id: { type: 'string', description: "The model's registry id (mdl-…)." } }, ['id']),
  },
  {
    name: 'luak_add_provider',
    description: 'Add a provider to Luak from a preset (see the presets in luak_registry). Optionally override label/baseUrl and supply an apiKeyEnv or apiKey.',
    parameters: obj({
      presetId: { type: 'string', description: 'A preset id from luak_registry.presets.' },
      label: { type: 'string', description: 'Custom label (optional).' },
      baseUrl: { type: 'string', description: 'Override base URL (optional).' },
      apiKeyEnv: { type: 'string', description: 'Name of an env var holding the API key (optional).' },
      apiKey: { type: 'string', description: 'Literal API key (optional; prefer apiKeyEnv).' },
      enabled: { type: 'boolean', description: 'Enabled (default true).' },
    }, ['presetId']),
  },
  {
    name: 'luak_test_provider',
    description: "Probe a provider's connectivity in Luak (bounded, safe). Needs the provider config id.",
    parameters: obj({ id: { type: 'string', description: 'The provider config id.' } }, ['id']),
  },
  {
    name: 'luak_run',
    description: 'Run a benchmark trial in Luak for a given task + model. Costs a real model call. Provide the task, adapter, and model (provider optional).',
    parameters: obj({
      task: { type: 'string', description: 'The benchmark task id/name to run.' },
      adapter: { type: 'string', description: 'The adapter to dispatch through (e.g. openrouter, anthropic, ollama).' },
      model: { type: 'string', description: 'The model id to test.' },
      provider: { type: 'string', description: 'Provider hint (optional).' },
    }, ['task', 'adapter', 'model']),
  },
  {
    name: 'luak_leaderboard',
    description: "Read Luak's leaderboard — ranked model scores (composite + per-family). Read-only.",
    parameters: obj({}, []),
  },
];

export const luakToolNames: ReadonlySet<string> = new Set(luakToolSpecs.map((s) => s.name));

export function createLuakToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('luak_registry', async (): Promise<ToolResult> =>
    toResult(await luakRequest('luak_registry', 'GET', '/api/registry/state')));

  handlers.set('luak_leaderboard', async (): Promise<ToolResult> =>
    toResult(await luakRequest('luak_leaderboard', 'GET', '/api/leaderboard')));

  handlers.set('luak_add_model', async (args): Promise<ToolResult> => {
    const providerConfigId = str(args.providerConfigId);
    const modelId = str(args.modelId);
    if (providerConfigId === '' || modelId === '') return { ok: false, output: '', error: 'luak_add_model needs providerConfigId and modelId (see luak_registry).' };
    return toResult(await luakRequest('luak_add_model', 'POST', '/api/registry/models', { providerConfigId, modelId, ...editFields(args) }));
  });

  handlers.set('luak_update_model', async (args): Promise<ToolResult> => {
    const id = str(args.id);
    if (id === '') return { ok: false, output: '', error: "luak_update_model needs the model's registry id (mdl-…)." };
    return toResult(await luakRequest('luak_update_model', 'PATCH', `/api/registry/models/${encodeURIComponent(id)}`, editFields(args)));
  });

  handlers.set('luak_remove_model', async (args): Promise<ToolResult> => {
    const id = str(args.id);
    if (id === '') return { ok: false, output: '', error: "luak_remove_model needs the model's registry id (mdl-…)." };
    return toResult(await luakRequest('luak_remove_model', 'DELETE', `/api/registry/models/${encodeURIComponent(id)}`));
  });

  handlers.set('luak_add_provider', async (args): Promise<ToolResult> => {
    const presetId = str(args.presetId);
    if (presetId === '') return { ok: false, output: '', error: 'luak_add_provider needs a presetId (see luak_registry.presets).' };
    const body: Record<string, unknown> = { presetId };
    for (const k of ['label', 'baseUrl', 'apiKeyEnv', 'apiKey'] as const) if (typeof args[k] === 'string') body[k] = args[k];
    if (typeof args.enabled === 'boolean') body.enabled = args.enabled;
    return toResult(await luakRequest('luak_add_provider', 'POST', '/api/registry/providers', body));
  });

  handlers.set('luak_test_provider', async (args): Promise<ToolResult> => {
    const id = str(args.id);
    if (id === '') return { ok: false, output: '', error: 'luak_test_provider needs the provider config id.' };
    return toResult(await luakRequest('luak_test_provider', 'POST', `/api/registry/providers/${encodeURIComponent(id)}/test`));
  });

  handlers.set('luak_run', async (args): Promise<ToolResult> => {
    const task = str(args.task); const adapter = str(args.adapter); const model = str(args.model);
    if (task === '' || adapter === '' || model === '') return { ok: false, output: '', error: 'luak_run needs task, adapter, and model.' };
    const body: Record<string, unknown> = { task, adapter, model };
    if (typeof args.provider === 'string') body.provider = args.provider;
    return toResult(await luakRequest('luak_run', 'POST', '/api/run', body));
  });

  return handlers;
}
