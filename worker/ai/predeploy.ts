import type { Env } from '../types';
import { MODEL_ANSWER_JSON_SCHEMA, MODEL_CONFIG, MODEL_CHAINS, reviewedNoTrainingEndpoint, type ModelKey } from './config';
import { controlFetch } from './control-plane';
import { sha256 } from './fingerprint';
import { retryAfterSeconds } from './retry-after';
import type { ApprovedEndpointSnapshot } from './types';

type Endpoint = Record<string, unknown>;
type RouterMetadata = { attempt?: number; is_byok?: boolean; provider?: string; provider_slug?: string; model?: string; endpoints?: { available?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>; attempts?: Array<Record<string, unknown>>; pipeline?: Array<Record<string, unknown>> };
type KeyStatusDiagnostic = {
  isFreeTier: boolean | null;
  isManagementKey: boolean | null;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number | null;
  usageDaily: number | null;
  usageWeekly: number | null;
  usageMonthly: number | null;
  byokUsage: number | null;
  includeByokInLimit: boolean | null;
  expiresAt: string | null;
};
type RequestContext = { ordinal: number; reusedResources: string[]; keyStatus?: KeyStatusDiagnostic };

export type RateLimitDiagnostic = {
  url: string;
  operation: string;
  modelKey: ModelKey | null;
  status: 429;
  retryAfterSeconds: number;
  requestOrdinal: number;
  rateLimitHeaders: Record<string, string>;
  responseBody: {
    code: string | number | null;
    message: string | null;
    type: string | null;
    providerName: string | null;
    upstreamCode: string | number | null;
    upstreamMessage: string | null;
    isByok: boolean | null;
  };
  keyStatus?: KeyStatusDiagnostic;
};

type MetadataProgress = {
  modelKey: ModelKey;
  endpoint: Endpoint;
  modalities: string[];
  pricing: Record<string, string | null>;
  nonApplicable: string[];
  supported: string[];
  generationPolicyVersion: string;
  zdr: boolean;
  trainingPolicySource?: string;
};

type SmokeProgress = MetadataProgress & { snapshot: ApprovedEndpointSnapshot; report: Record<string, unknown> };
type ProgressRow = { phase: 'METADATA_VALID' | 'SMOKE_VALID'; progress_json: string; expires_at: number };

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 60;
const PREDEPLOY_HTTP_TIMEOUT_MS = 15_000;
const PROGRESS_TTL_MS = 12 * 3_600_000;
// Keep the old array as a compatibility tail and as a visible audit record.
// New requested models are evaluated first below.
// Keep the privacy-only ZDR candidate first in the compatibility tail so a
// retained-provider 429 cannot prevent a currently eligible ZDR endpoint from
// being audited.  The requested public chains remain unchanged.
const TEXT_POLICY_KEYS: readonly ModelKey[] = ['lingVl', 'glm52', 'dots', 'gemma31', 'gemma26'];
const REQUESTED_TEXT_POLICY_KEYS: readonly ModelKey[] = [...MODEL_CHAINS.text];
const REQUESTED_VISION_POLICY_KEYS: readonly ModelKey[] = [...MODEL_CHAINS.vision];

export class AiPredeployError extends Error {
  constructor(public code: string, public retryAfterSeconds?: number, public diagnostic?: RateLimitDiagnostic) { super(code); }
}

type ModelPolicy = {
  model: string;
  endpointTag?: string;
  providerName?: string;
  requireZdr: boolean;
  /** Endpoint policy must explicitly say that prompts are not used for training. */
  requireNoTraining: boolean;
  retention: ApprovedEndpointSnapshot['retention'];
  requiresVision: boolean;
  requiresSchema: boolean;
};

const POLICIES: Record<ModelKey, ModelPolicy> = {
  minimaxM3: { model: MODEL_CONFIG.minimaxM3.id, requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: true, requiresSchema: false },
  nemotronUltra: { model: MODEL_CONFIG.nemotronUltra.id, requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: false, requiresSchema: false },
  hy3: { model: MODEL_CONFIG.hy3.id, requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: false, requiresSchema: false },
  minimaxM27: { model: MODEL_CONFIG.minimaxM27.id, requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: false, requiresSchema: false },
  lagunaS21: { model: MODEL_CONFIG.lagunaS21.id, requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: false, requiresSchema: false },
  inkling: { model: MODEL_CONFIG.inkling.id, requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: true, requiresSchema: false },
  // Novita's free Ling VL endpoint is listed by OpenRouter's authoritative ZDR
  // catalog.  It is only eligible after an exact endpoint/provider match,
  // explicit zero pricing, and a successful no-fallback smoke request.
  lingVl: { model: MODEL_CONFIG.lingVl.id, endpointTag: 'novita/bf16', providerName: 'Novita', requireZdr: true, requireNoTraining: true, retention: { type: 'zdr' }, requiresVision: true, requiresSchema: false },
  // Existing manually reviewed routes remain available as the compatibility
  // tail until every requested free model has a fresh snapshot.
  glm52: { model: MODEL_CONFIG.glm52.id, endpointTag: 'decart/fp4', providerName: 'Decart', requireZdr: true, requireNoTraining: true, retention: { type: 'zdr' }, requiresVision: false, requiresSchema: true },
  // OpenRouter's provider directory currently states that AtlasCloud does not
  // train on prompts but does retain them. The duration is not published, so
  // this is deliberately not represented as fixed-duration or ZDR. Runtime
  // policy consequently permits it only for PUBLIC_AI context.
  dots: { model: MODEL_CONFIG.dots.id, endpointTag: 'atlas-cloud/fp8', providerName: 'AtlasCloud', requireZdr: false, requireNoTraining: true, retention: { type: 'retained' }, requiresVision: true, requiresSchema: true },
  gemma31: { model: MODEL_CONFIG.gemma31.id, endpointTag: 'google-ai-studio', providerName: 'Google AI Studio', requireZdr: false, requireNoTraining: true, retention: { type: 'fixed', days: 55 }, requiresVision: true, requiresSchema: false },
  gemma26: { model: MODEL_CONFIG.gemma26.id, endpointTag: 'google-ai-studio', providerName: 'Google AI Studio', requireZdr: false, requireNoTraining: true, retention: { type: 'fixed', days: 55 }, requiresVision: true, requiresSchema: false },
};

function exactZeroPricing(endpoint: Endpoint): { pricing: Record<string, string | null>; nonApplicable: string[] } {
  const raw = (endpoint.pricing || {}) as Record<string, string | number | null>;
  const allowed = new Set(['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write', 'discount']);
  const pricing: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) throw new Error(`UNKNOWN_PRICING_SKU:${key}`);
    if (value === null || Number(value) !== 0) throw new Error(`NON_ZERO_OR_UNKNOWN_PRICE:${key}`);
    pricing[key] = String(value);
  }
  for (const key of ['prompt', 'completion']) if (!(key in pricing)) throw new Error(`MISSING_PRICE:${key}`);
  // Missing optional SKUs are recorded as N/A, never converted to numeric zero.
  const nonApplicable = ['request', 'image'].filter((key) => !(key in pricing));
  return { pricing, nonApplicable };
}

function selectedProvider(metadata: RouterMetadata): string | null {
  const endpoints = Array.isArray(metadata.endpoints) ? metadata.endpoints : metadata.endpoints?.available;
  const selected = endpoints?.find((endpoint) => endpoint.selected === true)
    || endpoints?.at(-1)
    || metadata.attempts?.at(-1);
  const value = selected?.provider || selected?.provider_slug || metadata.provider || metadata.provider_slug;
  return typeof value === 'string' ? value : null;
}

function endpointTag(endpoint: Endpoint): string {
  return String(endpoint.tag || endpoint.provider_slug || '').trim();
}

function endpointProvider(endpoint: Endpoint): string {
  return String(endpoint.provider_name || endpoint.provider || '').trim();
}

function endpointTrainingAllowed(endpoint: Endpoint): boolean | null {
  const policy = endpoint.data_policy;
  if (!policy || typeof policy !== 'object') return null;
  const value = policy as Record<string, unknown>;
  if (typeof value.training === 'boolean') return value.training;
  if (typeof value.train === 'boolean') return value.train;
  if (typeof value.data_collection === 'string') return value.data_collection.toLowerCase() !== 'deny';
  return null;
}

function endpointZdr(endpoint: Endpoint, model: string, tag: string, zdrPairs: string[]): boolean {
  const policy = endpoint.data_policy;
  if (policy && typeof policy === 'object' && typeof (policy as Record<string, unknown>).zdr === 'boolean') return Boolean((policy as Record<string, unknown>).zdr);
  // The ZDR catalog identifies the base model (for example `z-ai/glm-5.2`),
  // while the free endpoint catalog appends `:free`. Normalize only that
  // well-defined suffix; provider and endpoint tags must still match exactly.
  const baseModel = model.replace(/:free$/, '');
  return zdrPairs.some((pair) => {
    const separator = pair.lastIndexOf(':');
    if (separator < 0) return false;
    return pair.slice(0, separator).replace(/:free$/, '') === baseModel && pair.slice(separator + 1) === tag;
  });
}

function routerMetadata(response: Response, payload: Record<string, unknown>): RouterMetadata | undefined {
  const direct = payload.openrouter_metadata || payload.router_metadata;
  if (direct && typeof direct === 'object') return direct as RouterMetadata;
  const header = response.headers.get('x-openrouter-metadata');
  if (!header) return undefined;
  try { return JSON.parse(header) as RouterMetadata; } catch { return undefined; }
}

function rateLimitHeaders(response: Response): Record<string, string> {
  const names = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-policy', 'x-rate-limit-limit', 'x-rate-limit-remaining', 'x-rate-limit-reset', 'cf-ray'];
  return Object.fromEntries(names.flatMap((name) => {
    const value = response.headers.get(name);
    return value ? [[name, value] as const] : [];
  }));
}

function redactDiagnosticText(value: string, limit = 240): string {
  return value
    .replace(/(sk-or-v1-)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/(bearer\\s+)[^\\s,;]+/gi, '$1[REDACTED]')
    .slice(0, limit);
}

async function safeErrorBody(response: Response): Promise<RateLimitDiagnostic['responseBody']> {
  const payload: Record<string, unknown> = await response.clone().json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : payload;
  const value = (key: string): string | number | null => typeof error[key] === 'string' || typeof error[key] === 'number' ? error[key] as string | number : null;
  const metadata = error.metadata && typeof error.metadata === 'object' ? error.metadata as Record<string, unknown> : {};
  const raw = metadata.raw;
  let upstreamCode: string | number | null = typeof metadata.code === 'string' || typeof metadata.code === 'number' ? metadata.code : null;
  let upstreamMessage: string | null = typeof metadata.message === 'string' ? redactDiagnosticText(metadata.message) : null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const parsedError = parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : parsed;
      if (typeof parsedError.code === 'string' || typeof parsedError.code === 'number') upstreamCode = parsedError.code;
      if (typeof parsedError.message === 'string') upstreamMessage = redactDiagnosticText(parsedError.message);
    } catch { upstreamMessage = redactDiagnosticText(raw); }
  }
  return {
    code: value('code'),
    message: typeof value('message') === 'string' ? redactDiagnosticText(String(value('message'))) : null,
    type: typeof value('type') === 'string' ? String(value('type')).slice(0, 80) : null,
    providerName: typeof metadata.provider_name === 'string' ? metadata.provider_name.slice(0, 80) : null,
    upstreamCode,
    upstreamMessage,
    isByok: typeof metadata.is_byok === 'boolean' ? metadata.is_byok : null,
  };
}

async function requiredJson<T>(response: Response, operation: string): Promise<T> {
  try { return await response.json<T>(); }
  catch { throw new AiPredeployError(`${operation}_INVALID_JSON`); }
}

async function openRouterFetch(context: RequestContext, url: string, init: RequestInit, operation: string, modelKey: ModelKey | null): Promise<Response> {
  context.ordinal += 1;
  const timeout = AbortSignal.timeout(PREDEPLOY_HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } catch {
    if (timeout.aborted) throw new AiPredeployError(`${modelKey || 'global'}:${operation}_TIMEOUT`);
    throw new AiPredeployError(`${modelKey || 'global'}:${operation}_TRANSPORT_FAILURE`);
  }
  if (response.status !== 429) return response;
  if (response.status === 429) {
  const cooldown = retryAfterSeconds(response.headers.get('retry-after')) || DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
  const diagnostic: RateLimitDiagnostic = {
    url,
    operation,
    modelKey,
    status: 429,
    retryAfterSeconds: cooldown,
    requestOrdinal: context.ordinal,
    rateLimitHeaders: rateLimitHeaders(response),
    responseBody: await safeErrorBody(response),
    keyStatus: context.keyStatus,
  };
  throw new AiPredeployError(`${modelKey || 'global'}:${operation}_HTTP_429`, cooldown, diagnostic);
  }
  return response;
}

async function keyStatus(context: RequestContext, apiKey: string): Promise<KeyStatusDiagnostic> {
  const response = await openRouterFetch(context, `${OPENROUTER_BASE}/key`, { headers: { Authorization: `Bearer ${apiKey}` } }, 'RUNTIME_KEY_STATUS', null);
  if (!response.ok) throw new AiPredeployError(`RUNTIME_KEY_STATUS_HTTP_${response.status}`);
  const payload = await requiredJson<{ data?: Record<string, unknown> }>(response, 'RUNTIME_KEY_STATUS');
  const data = payload.data || {};
  const number = (name: string): number | null => typeof data[name] === 'number' && Number.isFinite(data[name]) ? data[name] as number : null;
  const boolean = (name: string): boolean | null => typeof data[name] === 'boolean' ? data[name] as boolean : null;
  const string = (name: string): string | null => typeof data[name] === 'string' ? data[name] as string : null;
  return {
    isFreeTier: boolean('is_free_tier'),
    isManagementKey: boolean('is_management_key'),
    limit: number('limit'),
    limitRemaining: number('limit_remaining'),
    limitReset: string('limit_reset'),
    usage: number('usage'),
    usageDaily: number('usage_daily'),
    usageWeekly: number('usage_weekly'),
    usageMonthly: number('usage_monthly'),
    byokUsage: number('byok_usage'),
    includeByokInLimit: boolean('include_byok_in_limit'),
    expiresAt: string('expires_at'),
  };
}

async function loadProgress<T>(db: D1Database, resourceKey: string, phase?: ProgressRow['phase']): Promise<T | null> {
  const row = await db.prepare(`SELECT phase,progress_json,expires_at FROM ai_predeploy_progress WHERE resource_key=? AND expires_at>?`).bind(resourceKey, Date.now()).first<ProgressRow>();
  if (!row || (phase && row.phase !== phase)) return null;
  try { return JSON.parse(row.progress_json) as T; } catch { return null; }
}

async function saveProgress(db: D1Database, resourceKey: string, phase: ProgressRow['phase'], progress: unknown, stamp: number): Promise<void> {
  await db.prepare(`INSERT INTO ai_predeploy_progress(resource_key,phase,progress_json,verified_at,expires_at) VALUES(?,?,?,?,?)
    ON CONFLICT(resource_key) DO UPDATE SET phase=excluded.phase,progress_json=excluded.progress_json,verified_at=excluded.verified_at,expires_at=excluded.expires_at`)
    .bind(resourceKey, phase, JSON.stringify(progress), stamp, stamp + PROGRESS_TTL_MS).run();
}

async function saveSnapshot(db: D1Database, snapshotId: string, modelKey: ModelKey, snapshot: ApprovedEndpointSnapshot, report: Record<string, unknown>, verifiedAtMs: number): Promise<void> {
  await db.prepare(`INSERT INTO ai_endpoint_snapshots(snapshot_id,model_key,requested_model,canonical_model,provider_model,provider_base_slug,provider_endpoint_slug,policy_state,snapshot_json,generation_policy_version,verified_at,expires_at,manually_accepted_at) VALUES(?,?,?,?,?,?,?,'VALID',?,?,?,?,?)
    ON CONFLICT(snapshot_id) DO UPDATE SET policy_state='VALID',snapshot_json=excluded.snapshot_json,verified_at=excluded.verified_at,expires_at=excluded.expires_at,manually_accepted_at=excluded.manually_accepted_at`)
    .bind(snapshotId, modelKey, snapshot.requestedModel, snapshot.canonicalModel, snapshot.providerModel, snapshot.providerBaseSlug, snapshot.providerEndpointSlug, JSON.stringify({ ...snapshot, predeployAudit: report }), snapshot.generationPolicyVersion, verifiedAtMs, verifiedAtMs + PROGRESS_TTL_MS, verifiedAtMs).run();
}

async function smoke(context: RequestContext, apiKey: string, modelKey: ModelKey, policy: ModelPolicy, metadataProgress: MetadataProgress): Promise<{ actualModel: string; provider: string; cost: number; generationId: string; metadata: RouterMetadata }> {
  const provider: Record<string, unknown> = { only: [endpointTag(metadataProgress.endpoint)], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } };
  if (policy.requireZdr) { provider.zdr = true; provider.data_collection = 'deny'; }
  const body: Record<string, unknown> = { model: policy.model, messages: [{ role: 'system', content: 'Return only the requested JSON.' }, { role: 'user', content: 'Return {"answer":"ok","citedRefs":[],"insufficientContext":false}.' }], stream: false, temperature: 0, max_tokens: 64, provider };
  if (metadataProgress.supported.includes('response_format')) {
    body.response_format = policy.requiresSchema && metadataProgress.supported.includes('structured_outputs')
      ? { type: 'json_schema', json_schema: MODEL_ANSWER_JSON_SCHEMA }
      : { type: 'json_object' };
  }
  const url = `${OPENROUTER_BASE}/chat/completions`;
  const response = await openRouterFetch(context, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Metadata': 'enabled', 'X-OpenRouter-Cache': 'false', 'HTTP-Referer': 'https://sns-app-ashen.vercel.app', 'X-OpenRouter-Title': 'Connect Ask AI predeploy' },
    body: JSON.stringify(body),
  }, 'SMOKE', modelKey);
  const payload: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  const metadata = routerMetadata(response, payload);
  if (!response.ok) {
    const suffix = metadata?.attempt === 0 ? '_NO_ELIGIBLE_ENDPOINT' : '';
    throw new AiPredeployError(`${modelKey}:SMOKE_HTTP_${response.status}${suffix}`);
  }
  if (!metadata || metadata.attempt !== 1 || metadata.is_byok !== false) throw new Error('ROUTER_METADATA_INVARIANT');
  const actualProvider = selectedProvider(metadata);
  const expectedProvider = endpointProvider(metadataProgress.endpoint);
  if (!actualProvider || (expectedProvider && actualProvider.toLowerCase() !== expectedProvider.toLowerCase())) throw new Error('ACTUAL_PROVIDER_MISMATCH');
  for (const stage of metadata.pipeline || []) {
    const type = String(stage.type || stage.name || '').toLowerCase().replaceAll('-', '_');
    if (['context_compression', 'server_tools', 'web_search', 'file_parser', 'response_healing'].includes(type)) throw new Error(`UNEXPECTED_PIPELINE:${type}`);
  }
  const rawCost = (payload.usage as Record<string, unknown> | undefined)?.cost;
  if (typeof rawCost !== 'number' || !Number.isFinite(rawCost) || rawCost !== 0) throw new Error('COST_NOT_EXPLICIT_ZERO');
  const content = String(((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content || '');
  JSON.parse(content);
  const generationId = typeof payload.id === 'string' ? payload.id : '';
  if (!generationId) throw new Error('GENERATION_ID_MISSING');
  return { actualModel: String(payload.model || policy.model), provider: actualProvider, cost: rawCost, generationId, metadata };
}

export async function runAiPredeploy(env: Env): Promise<{ verifiedAt: string; reports: Array<Record<string, unknown>>; requestCount: number; reusedResources: string[]; runtimeKeyStatus: KeyStatusDiagnostic }> {
  if (!env.DB || !env.OPENROUTER_API_KEY?.trim()) throw new Error('PREDEPLOY_CONFIGURATION_MISSING');
  const db = env.DB;
  const runtimeResponse = await controlFetch(env, '/runtime');
  await runtimeResponse.json<Record<string, unknown>>().catch(() => ({}));
  if (!runtimeResponse.ok) throw new AiPredeployError('PREDEPLOY_CONTROL_PLANE_UNAVAILABLE');

  const context: RequestContext = { ordinal: 0, reusedResources: [] };
  const runtimeKeyStatus = await keyStatus(context, env.OPENROUTER_API_KEY);
  context.keyStatus = runtimeKeyStatus;
  let zdrPairs = await loadProgress<string[]>(db, 'zdr');
  if (zdrPairs) context.reusedResources.push('zdr');
  else {
    const zdrResponse = await openRouterFetch(context, `${OPENROUTER_BASE}/endpoints/zdr`, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }, 'ZDR_API', null);
    if (!zdrResponse.ok) throw new AiPredeployError(`ZDR_API_HTTP_${zdrResponse.status}`);
    const zdrPayload = await requiredJson<{ data?: Endpoint[] }>(zdrResponse, 'ZDR_API');
    zdrPairs = (zdrPayload.data || []).map((candidate) => `${candidate.model_id}:${candidate.tag}`);
    await saveProgress(db, 'zdr', 'METADATA_VALID', zdrPairs, Date.now());
  }

  const reports: Array<Record<string, unknown>> = [];
  const snapshots: Array<{ snapshotId: string; modelKey: ModelKey; snapshot: ApprovedEndpointSnapshot; report: Record<string, unknown>; verifiedAtMs: number }> = [];
  const attemptedEndpoints = new Set<string>();

  const verifyRoute = async (keys: readonly ModelKey[]): Promise<number> => {
    let verified = 0;
    for (const [modelIndex, modelKey] of keys.entries()) {
      const policy = POLICIES[modelKey];
      if (!policy.model.endsWith(':free')) throw new Error(`${modelKey}:MODEL_NOT_FREE`);
      const resourceKey = `model:${modelKey}`;
      const completed = await loadProgress<SmokeProgress>(db, resourceKey, 'SMOKE_VALID');
      if (completed) {
        context.reusedResources.push(resourceKey);
        const stamp = Date.parse(completed.snapshot.verifiedAt);
        const snapshotId = `${modelKey}:${completed.generationPolicyVersion}`;
        await saveSnapshot(db, snapshotId, modelKey, completed.snapshot, completed.report, stamp);
        snapshots.push({ snapshotId, modelKey, snapshot: completed.snapshot, report: completed.report, verifiedAtMs: stamp });
        reports.push(completed.report);
        verified += 1;
        break;
      }

      let metadata = await loadProgress<MetadataProgress>(db, resourceKey, 'METADATA_VALID');
      if (metadata) context.reusedResources.push(resourceKey);
      else {
        const [author, ...parts] = policy.model.split('/');
        const url = `${OPENROUTER_BASE}/models/${author}/${parts.join('/')}/endpoints`;
        let response: Response;
        try {
          response = await openRouterFetch(context, url, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }, 'ENDPOINT_API', modelKey);
        } catch (cause) {
          // A 429 is already a route-wide chain stop with a durable breaker;
          // transport/timeout failures are model-scoped and must not prevent
          // the next approved free model from being inspected.
          if (cause instanceof AiPredeployError && cause.retryAfterSeconds) throw cause;
          reports.push({ modelKey, endpoint: policy.endpointTag || 'dynamic-free-endpoint', state: 'SKIPPED_ENDPOINT_API_FAILURE', reason: cause instanceof Error ? cause.message.slice(0, 96) : 'ENDPOINT_API_FAILURE' });
          continue;
        }
        if (!response.ok) {
          // Auth, billing, and forbidden responses describe the production
          // key/account and cannot be repaired by trying another model.
          if ([401, 402, 403].includes(response.status)) throw new AiPredeployError(`${modelKey}:ENDPOINT_API_HTTP_${response.status}`);
          reports.push({ modelKey, endpoint: policy.endpointTag || 'dynamic-free-endpoint', state: 'SKIPPED_ENDPOINT_API_UNAVAILABLE', reason: `HTTP_${response.status}` });
          continue;
        }
        let payload: { data?: { id?: string; architecture?: { input_modalities?: string[] }; endpoints?: Endpoint[] } };
        try {
          payload = await requiredJson<{ data?: { id?: string; architecture?: { input_modalities?: string[] }; endpoints?: Endpoint[] } }>(response, `${modelKey}:ENDPOINT_API`);
        } catch (cause) {
          reports.push({ modelKey, endpoint: policy.endpointTag || 'dynamic-free-endpoint', state: 'SKIPPED_ENDPOINT_API_MALFORMED', reason: cause instanceof Error ? cause.message.slice(0, 96) : 'ENDPOINT_API_INVALID_JSON' });
          continue;
        }
        const modalities = payload.data?.architecture?.input_modalities || [];
        const candidates = (payload.data?.endpoints || []).filter((candidate) => {
          const tag = endpointTag(candidate);
          const provider = endpointProvider(candidate);
          return (!policy.endpointTag || tag === policy.endpointTag) && (!policy.providerName || provider.toLowerCase() === policy.providerName.toLowerCase());
        });
        let selected: { endpoint: Endpoint; pricing: Record<string, string | null>; nonApplicable: string[]; supported: string[]; zdr: boolean } | null = null;
        let rejection = 'ENDPOINT_UNAVAILABLE';
        for (const candidate of candidates) {
          try {
            const { pricing, nonApplicable } = exactZeroPricing(candidate);
            const supported = Array.isArray(candidate.supported_parameters) ? candidate.supported_parameters.map(String) : [];
            if (!supported.includes('max_tokens')) throw new Error(`${modelKey}:MAX_TOKENS_UNSUPPORTED`);
            if (policy.requiresSchema && (!supported.includes('response_format') || !supported.includes('structured_outputs'))) throw new Error(`${modelKey}:JSON_SCHEMA_UNSUPPORTED`);
            if (policy.requiresVision && !modalities.includes('image')) throw new Error(`${modelKey}:VISION_UNSUPPORTED`);
            const tag = endpointTag(candidate);
            const provider = endpointProvider(candidate);
            const zdr = endpointZdr(candidate, policy.model, tag, zdrPairs);
            if (policy.requireZdr && !zdr) throw new Error(`${modelKey}:ZDR_NOT_CONFIRMED`);
            const endpointTraining = endpointTrainingAllowed(candidate);
            const reviewedPolicy = reviewedNoTrainingEndpoint(policy.model, provider, tag);
            // `data_policy:null` is still rejected for every unreviewed route.
            // For the exact reviewed provider/model/tag tuples above, the
            // provider-directory no-training finding is the explicit policy
            // evidence that the current endpoint API omitted.
            const training = endpointTraining ?? (reviewedPolicy ? false : null);
             // OpenRouter documents that a ZDR endpoint cannot train on
             // prompts. When the authoritative ZDR catalog confirms the
             // endpoint but the per-endpoint training field is omitted, this
             // is one safe exception; the other is the exact reviewed
             // provider/model/tag allowlist above. Every other unknown stays
             // fail-closed.
            if (policy.requireNoTraining && training !== false && !(policy.requireZdr && zdr && training === null)) throw new Error(`${modelKey}:TRAINING_POLICY_NOT_EXPLICITLY_DENIED`);
            selected = { endpoint: candidate, pricing, nonApplicable, supported, zdr };
            break;
          } catch (cause) {
            rejection = cause instanceof Error ? cause.message.slice(0, 96) : 'POLICY_REJECTED';
          }
        }
        if (!selected) {
          reports.push({ modelKey, endpoint: policy.endpointTag || 'dynamic-free-endpoint', state: candidates.length ? 'SKIPPED_POLICY_REJECTED' : 'SKIPPED_ENDPOINT_UNAVAILABLE', reason: rejection });
          continue;
        }
        const tag = endpointTag(selected.endpoint);
        const provider = endpointProvider(selected.endpoint);
        const reviewedPolicy = reviewedNoTrainingEndpoint(policy.model, provider, tag);
        const trainingPolicySource = endpointTrainingAllowed(selected.endpoint) === null && reviewedPolicy ? reviewedPolicy.source : 'endpoint';
        const generationPolicyVersion = await sha256(JSON.stringify({ modelKey, model: policy.model, endpoint: tag, provider, retention: policy.retention, pricing: selected.pricing, nonApplicable: selected.nonApplicable, supported: selected.supported, zdr: selected.zdr, trainingPolicySource }));
        metadata = { modelKey, endpoint: selected.endpoint, modalities, pricing: selected.pricing, nonApplicable: selected.nonApplicable, supported: selected.supported, generationPolicyVersion, zdr: selected.zdr, trainingPolicySource };
        await saveProgress(db, resourceKey, 'METADATA_VALID', metadata, Date.now());
      }

      const tag = endpointTag(metadata.endpoint);
      const provider = endpointProvider(metadata.endpoint);
      const providerScope = `predeploy:${tag}`;
      if (attemptedEndpoints.has(tag)) {
        reports.push({ modelKey, endpoint: tag, state: 'SKIPPED_DUPLICATE_ENDPOINT' });
        continue;
      }
      const breaker = await controlFetch(env, '/breaker/check', { scope: providerScope });
      if (!breaker.ok) {
        reports.push({ modelKey, endpoint: tag, state: 'CIRCUIT_OPEN' });
        continue;
      }
      attemptedEndpoints.add(tag);
      let actual: Awaited<ReturnType<typeof smoke>>;
      // Smoke with the exact runtime key so predeploy validates the production
      // budget, guardrail, privacy, and routing state with the same production
      // Worker Secret used by the runtime request path.
      try { actual = await smoke(context, env.OPENROUTER_API_KEY, modelKey, policy, metadata); }
      catch (cause) {
        if (cause instanceof AiPredeployError && cause.retryAfterSeconds) {
          await controlFetch(env, '/breaker/open', { scope: providerScope, until: Date.now() + Math.max(60, cause.retryAfterSeconds) * 1_000 });
          reports.push({ modelKey, endpoint: tag, state: 'CIRCUIT_OPEN_RATE_LIMITED', diagnostic: cause.diagnostic });
           // A 429 is a chain stop. Do not spend another free-provider request while the runtime key or provider is explicitly cooling down.
          throw cause;
        }
        // A malformed response, provider mismatch, or explicit zero-cost
        // invariant failure is scoped to this endpoint. Continue through the
        // finite approved chain so one bad model cannot suppress a later ZDR
        // candidate. Only 429 remains a route-wide chain stop above.
        reports.push({ modelKey, endpoint: tag, state: 'SKIPPED_SMOKE_FAILURE', reason: cause instanceof Error ? cause.message.slice(0, 96) : 'SMOKE_FAILURE' });
        continue;
      }
      const verifiedAtMs = Date.now();
      const verifiedAt = new Date(verifiedAtMs).toISOString();
      const providerModel = String(metadata.endpoint.name || '').split('|').slice(1).join('|').trim() || actual.actualModel;
      const snapshot: ApprovedEndpointSnapshot = {
        requestedModel: policy.model, canonicalModel: actual.actualModel, providerModel,
        providerBaseSlug: provider || actual.provider, providerEndpointSlug: tag,
        trainingAllowed: false, retention: policy.retention, pricing: metadata.pricing, nonApplicablePricingDimensions: metadata.nonApplicable,
        supportedParameters: metadata.supported, verifiedAt, expiresAt: new Date(verifiedAtMs + PROGRESS_TTL_MS).toISOString(), generationPolicyVersion: metadata.generationPolicyVersion,
      };
      const report = {
        modelKey, requestedModel: policy.model, actualModel: actual.actualModel, provider: actual.provider, endpoint: tag,
        promptPrice: metadata.pricing.prompt, completionPrice: metadata.pricing.completion,
        requestPrice: metadata.pricing.request ?? 'N/A', imagePrice: metadata.pricing.image ?? 'N/A',
        byok: false, attempt: 1, fallback: modelIndex > 0, generationId: actual.generationId, cost: actual.cost,
        retention: policy.retention, trainingAllowed: false, dataCollection: policy.requireZdr ? 'deny' : 'provider-policy', trainingPolicySource: metadata.trainingPolicySource || 'endpoint', zdr: metadata.zdr,
        structuredOutput: policy.requiresSchema ? 'json_schema' : (metadata.supported.includes('response_format') ? 'json_object' : 'prompt_json'),
      };
      const progress: SmokeProgress = { ...metadata, snapshot, report };
      await saveProgress(db, resourceKey, 'SMOKE_VALID', progress, verifiedAtMs);
      const snapshotId = `${modelKey}:${metadata.generationPolicyVersion}`;
      // Publish each independently verified endpoint immediately. A later model
      // or provider failure can never discard a successful zero-cost audit.
      await saveSnapshot(db, snapshotId, modelKey, snapshot, report, verifiedAtMs);
      snapshots.push({ snapshotId, modelKey, snapshot, report, verifiedAtMs });
      reports.push(report);
      verified += 1;
      break;
    }
    return verified;
  };

  const textVerified = await verifyRoute([...REQUESTED_TEXT_POLICY_KEYS, ...TEXT_POLICY_KEYS]);
  // A separate vision pass gives the requested multimodal chain its own
  // snapshot when the first text model is not vision-capable. Shared progress
  // and endpoint de-duplication ensure this remains one bounded predeploy run.
  await verifyRoute([...REQUESTED_VISION_POLICY_KEYS, ...TEXT_POLICY_KEYS]);
  if (!textVerified && !snapshots.length) throw new AiPredeployError('NO_VALID_TEXT_ENDPOINT');
  return { verifiedAt: new Date(Math.max(...snapshots.map((item) => item.verifiedAtMs))).toISOString(), reports, requestCount: context.ordinal, reusedResources: context.reusedResources, runtimeKeyStatus };
}
