import { z } from 'zod';
import type { Env } from '../types';
import { AI_LIMITS, MODEL_ANSWER_JSON_SCHEMA, MODEL_CONFIG, type ModelKey } from './config';
import { answerMatchesQuestionLanguage, buildSystemPrompt, detectQuestionLanguage } from './prompt';
import { retryAfterSeconds } from './retry-after';
import type { ApprovedEndpointSnapshot, MaterializedImage, ModelAnswer, PrivacyClass } from './types';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

const modelAnswerSchema = z.object({
  answer: z.string().max(AI_LIMITS.answerChars),
  citedRefs: z.array(z.string()).max(32),
  usedMediaRefs: z.array(z.string()).max(4).optional(),
  insufficientContext: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (!value.insufficientContext && !value.answer.trim()) ctx.addIssue({ code: 'custom', message: 'answer required' });
});

type RouterMetadata = { attempt?: number; is_byok?: boolean; provider?: string; provider_slug?: string; model?: string; endpoints?: Array<Record<string, unknown>> | { available?: Array<Record<string, unknown>> }; attempts?: Array<Record<string, unknown>>; pipeline?: Array<Record<string, unknown>> };

type GenerationRecord = {
  model?: unknown;
  provider_name?: unknown;
  is_byok?: unknown;
  total_cost?: unknown;
  usage?: unknown;
};

export type RoutingAudit = {
  actualModel: string;
  actualProvider: string;
  byok: false;
  attempt: 1;
  reportedCost: number;
  costVerification: 'ZERO';
};

export class AiUpstreamError extends Error {
  constructor(
    public code: string,
    public status = 503,
    public fallbackEligible = false,
    public retryAfter?: number,
    public diagnostic?: string,
    public finishReason?: string,
  ) { super(code); }
}

function upstreamDiagnostic(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  const value = typeof error === 'string'
    ? error
    : error && typeof error === 'object'
      ? String((error as Record<string, unknown>).code || (error as Record<string, unknown>).type || (error as Record<string, unknown>).message || '')
      : '';
  const normalized = value.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 96);
  return normalized || undefined;
}

export async function endpointSnapshot(db: D1Database, modelKey: ModelKey, privacyClass: PrivacyClass): Promise<ApprovedEndpointSnapshot> {
  const now = Date.now();
  const row = await db.prepare(`SELECT snapshot_json,policy_state,expires_at FROM ai_endpoint_snapshots WHERE model_key=? ORDER BY verified_at DESC LIMIT 1`)
    .bind(modelKey).first<{ snapshot_json: string; policy_state: string; expires_at: number }>();
  if (!row) throw new AiUpstreamError('AI_MODEL_UNAVAILABLE', 503, false, undefined, 'SNAPSHOT_MISSING');
  if (row.policy_state !== 'VALID') throw new AiUpstreamError('AI_POLICY_OR_CAPABILITY_UNAVAILABLE', 503, false, undefined, 'SNAPSHOT_POLICY_STATE');
  if (Number(row.expires_at) <= now) throw new AiUpstreamError('AI_MODEL_UNAVAILABLE', 503, false, undefined, 'SNAPSHOT_EXPIRED');
  let snapshot: ApprovedEndpointSnapshot;
  try { snapshot = JSON.parse(row.snapshot_json) as ApprovedEndpointSnapshot; }
  catch { throw new AiUpstreamError('AI_POLICY_OR_CAPABILITY_UNAVAILABLE', 503, false, undefined, 'SNAPSHOT_INVALID'); }
  if (snapshot.retention.type === 'unknown' || snapshot.trainingAllowed !== false) throw new AiUpstreamError('AI_POLICY_OR_CAPABILITY_UNAVAILABLE', 503, false, undefined, 'ENDPOINT_POLICY_MISMATCH');
  if (privacyClass !== 'PUBLIC_AI' && snapshot.retention.type !== 'zdr') throw new AiUpstreamError('PRIVACY_COMPATIBLE_PROVIDER_UNAVAILABLE', 503, false, undefined, 'RETENTION_MISMATCH');
  for (const required of ['prompt', 'completion']) {
    if (!(required in snapshot.pricing) || snapshot.pricing[required] === null || Number(snapshot.pricing[required]) !== 0) throw new AiUpstreamError('AI_BILLING_POLICY_VIOLATION', 503, false, undefined, `PRICE_${required.toUpperCase()}_MISMATCH`);
  }
  for (const [key, value] of Object.entries(snapshot.pricing)) {
    if (!['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write', 'discount'].includes(key)) throw new AiUpstreamError('AI_BILLING_POLICY_VIOLATION', 503, false, undefined, 'PRICE_DIMENSION_UNKNOWN');
    if (value === null || Number(value) !== 0) throw new AiUpstreamError('AI_BILLING_POLICY_VIOLATION', 503, false, undefined, `PRICE_${key.toUpperCase()}_MISMATCH`);
  }
  for (const dimension of ['request', 'image']) if (!(dimension in snapshot.pricing) && !snapshot.nonApplicablePricingDimensions?.includes(dimension)) throw new AiUpstreamError('AI_BILLING_POLICY_VIOLATION', 503, false, undefined, `PRICE_${dimension.toUpperCase()}_MISSING`);
  return snapshot;
}

function modelProfile(key: ModelKey) {
  return MODEL_CONFIG[key];
}

function responseFormat(key: ModelKey, snapshot: ApprovedEndpointSnapshot): Record<string, unknown> | undefined {
  // Several of the requested free endpoints intentionally do not advertise
  // response_format. Sending it with require_parameters=true would make the
  // router reject an otherwise usable endpoint. The system prompt still asks
  // for JSON and the response parser remains fail-closed.
  if (!snapshot.supportedParameters.includes('response_format')) return undefined;
  return modelProfile(key).outputMode === 'json_schema' && snapshot.supportedParameters.includes('structured_outputs')
    ? { type: 'json_schema', json_schema: MODEL_ANSWER_JSON_SCHEMA }
    : { type: 'json_object' };
}

function userContent(question: string, contextJson: string, images: MaterializedImage[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: `QUESTION:\n${question}\n\nCONNECT_CONTEXT:\n${contextJson}` }];
  for (const image of images) {
    content.push({ type: 'text', text: `IMAGE ${image.ref} belongs_to=${image.belongsTo} position=${image.position}` });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  return content;
}

function requestBody(key: ModelKey, snapshot: ApprovedEndpointSnapshot, privacyClass: PrivacyClass, question: string, contextJson: string, images: MaterializedImage[], compact = false, maxTokens?: number) {
  const model = modelProfile(key);
  const systemPrompt = buildSystemPrompt(question);
  const provider: Record<string, unknown> = {
    only: [snapshot.providerEndpointSlug], allow_fallbacks: false, require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  };
  if (privacyClass !== 'PUBLIC_AI') { provider.zdr = true; provider.data_collection = 'deny'; }
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [{ role: 'system', content: compact
      ? `${systemPrompt}\n\nRETRY_INSTRUCTION: Return one concise valid JSON object only. Do not add explanation outside JSON. Use only the supplied CONNECT_CONTEXT and keep the answer brief. Continue to obey the RESPONSE_LANGUAGE rule above.`
      : systemPrompt }, { role: 'user', content: userContent(question, contextJson, images) }],
    stream: false,
    temperature: 0.2,
    // The currently approved free endpoints advertise `max_tokens` (not
    // `max_completion_tokens`) in supported_parameters. With
    // require_parameters=true the router correctly rejects the latter.
    max_tokens: maxTokens === undefined
      ? (compact ? Math.min(model.maxCompletionTokens, 1_200) : model.maxCompletionTokens)
      : Math.min(maxTokens, model.maxCompletionTokens),
    provider,
  };
  const format = responseFormat(key, snapshot);
  if (format) body.response_format = format;
  return body;
}

function assistantContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      if (typeof part === 'string') return [part];
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      for (const key of ['text', 'output_text']) {
        if (typeof record[key] === 'string') return [record[key] as string];
      }
      if (record.json && typeof record.json === 'object') return [JSON.stringify(record.json)];
      if (record.content !== undefined) {
        const nested = assistantContentText(record.content);
        return nested ? [nested] : [];
      }
      if ('answer' in record || 'citedRefs' in record) return [JSON.stringify(record)];
      return [];
    }).join('');
  }
  if (!content || typeof content !== 'object') return '';
  const record = content as Record<string, unknown>;
  for (const key of ['text', 'output_text']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  if (record.json && typeof record.json === 'object') return JSON.stringify(record.json);
  if (record.content !== undefined) {
    const nested = assistantContentText(record.content);
    if (nested) return nested;
  }
  // A few OpenRouter-compatible providers return the structured JSON object
  // directly in message.content instead of serializing it as text.
  if ('answer' in record || 'citedRefs' in record) return JSON.stringify(record);
  return '';
}

function parseOpenRouterSse(raw: string): Record<string, unknown> | null {
  if (!/^\s*data:/mu.test(raw)) return null;
  let id: string | undefined;
  let model: string | undefined;
  let finishReason: string | undefined;
  let content = '';
  let usage: unknown;
  let openrouterMetadata: unknown;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') continue;
    let chunk: Record<string, unknown>;
    try { chunk = JSON.parse(value) as Record<string, unknown>; } catch { continue; }
    if (typeof chunk.id === 'string') id = chunk.id;
    if (typeof chunk.model === 'string') model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.openrouter_metadata) openrouterMetadata = chunk.openrouter_metadata;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] as Record<string, unknown> | undefined : undefined;
    if (!choice) continue;
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    const delta = choice.delta as Record<string, unknown> | undefined;
    const message = choice.message as Record<string, unknown> | undefined;
    content += assistantContentText(delta?.content ?? message?.content);
  }
  if (!id && !model && !content && !usage && !openrouterMetadata) return null;
  return {
    id,
    model,
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage,
    openrouter_metadata: openrouterMetadata,
  };
}

function parseOpenRouterResponse(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return parseOpenRouterSse(raw);
  }
}

function responseShape(raw: string, contentType: string | null): string {
  if (!raw) return 'empty';
  if (contentType?.includes('text/event-stream') || /^\s*data:/mu.test(raw)) return 'sse';
  if (/^\s*</u.test(raw)) return 'html_or_xml';
  if (/^\s*\{/u.test(raw)) return 'json_like';
  return 'text';
}

function parseJsonAnswer(content: string): unknown {
  const candidates = [content.trim()];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const objectStart = content.indexOf('{');
  const objectEnd = content.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(content.slice(objectStart, objectEnd + 1));
  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    try { return JSON.parse(candidate); } catch { /* try the next bounded representation */ }
  }
  return null;
}

function incompleteAnswerReason(answer: string): 'TRAILING_COLON' | null {
  return /[：:]\s*$/u.test(answer.trim()) ? 'TRAILING_COLON' : null;
}

function rejectIncompleteAnswer(input: { key: ModelKey; requestId?: string }, answer: string, finishReason: string | undefined, reason: 'TRAILING_COLON'): AiUpstreamError {
  console.log(JSON.stringify({
    event: 'ai_model_answer_rejected',
    requestId: input.requestId,
    model: input.key,
    reason,
    answerLength: answer.length,
    finishReason: finishReason?.slice(0, 48) || null,
    bodyLogged: false,
    piiLogged: false,
  }));
  return new AiUpstreamError('MODEL_OUTPUT_MALFORMED', 503, true, undefined, reason, finishReason);
}

function rejectLanguageMismatch(input: { key: ModelKey; requestId?: string; question: string }, answer: string, finishReason: string | undefined): AiUpstreamError {
  console.log(JSON.stringify({
    event: 'ai_model_language_mismatch',
    requestId: input.requestId,
    model: input.key,
    expectedLanguage: detectQuestionLanguage(input.question),
    answerLength: answer.length,
    bodyLogged: false,
    piiLogged: false,
  }));
  return new AiUpstreamError('MODEL_LANGUAGE_MISMATCH', 503, true, undefined, 'QUESTION_LANGUAGE_MISMATCH', finishReason);
}

function requireQuestionLanguage(input: { key: ModelKey; requestId?: string; question: string }, answer: string, finishReason: string | undefined): void {
  if (!answerMatchesQuestionLanguage(input.question, answer)) throw rejectLanguageMismatch(input, answer, finishReason);
}

function modelOutputDiagnostic(key: ModelKey, content: unknown, parsed: unknown, response: Response, finishReason: unknown): void {
  const text = assistantContentText(content);
  const parsedObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const contentObject = content && typeof content === 'object' && !Array.isArray(content) ? content as Record<string, unknown> : null;
  console.log(JSON.stringify({
    event: 'ai_model_output_invalid',
    model: key,
    contentType: Array.isArray(content) ? 'array' : typeof content,
    contentLength: text.length,
    contentKeys: contentObject ? Object.keys(contentObject).slice(0, 12) : [],
    startsWithJsonFence: /^\s*```/u.test(text),
    startsWithObject: /^\s*\{/u.test(text),
    parsedType: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
    parsedKeys: parsedObject ? Object.keys(parsedObject).slice(0, 12) : [],
    finishReason: typeof finishReason === 'string' ? finishReason.slice(0, 48) : undefined,
    responseModel: typeof response.headers.get('x-openrouter-model') === 'string' ? response.headers.get('x-openrouter-model') : undefined,
  }));
}

function metadataFrom(response: Response, payload: Record<string, unknown>): RouterMetadata | null {
  const direct = payload.openrouter_metadata || payload.router_metadata;
  if (direct && typeof direct === 'object') return direct as RouterMetadata;
  const header = response.headers.get('x-openrouter-metadata');
  if (!header) return null;
  try { return JSON.parse(header) as RouterMetadata; } catch { return null; }
}

function numericZero(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * OpenRouter normally returns openrouter_metadata inline.  A small number of
 * successful edge responses can omit that additive field even though the
 * generation has an id.  The generation endpoint is the documented
 * post-mortem source for model/provider/cost, so make one bounded read before
 * failing closed.  This is not a retry of the completion and never submits a
 * second prompt.
 */
async function metadataFromGenerationRecord(input: {
  env: Env;
  generationId: string | null;
  snapshot: ApprovedEndpointSnapshot;
  signal: AbortSignal;
}): Promise<RoutingAudit | null> {
  const logLookup = (reason: string, fields: Record<string, unknown> = {}): void => {
    // Keep the fallback audit diagnosable without logging the prompt, image
    // data, API key, or provider response body.
    console.log(JSON.stringify({ event: 'ai_router_metadata_lookup', reason, ...fields }));
  };
  if (!input.generationId) {
    logLookup('generation_id_missing');
    return null;
  }
  const lookupSignal = AbortSignal.any([input.signal, AbortSignal.timeout(2_000)]);
  let response: Response;
  try {
    response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(input.generationId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.env.OPENROUTER_API_KEY}` },
      signal: lookupSignal,
    });
  } catch (cause) {
    logLookup('generation_lookup_transport_failure', { error: cause instanceof Error ? cause.name : 'unknown' });
    return null;
  }
  if (!response.ok) {
    logLookup('generation_lookup_http_failure', { status: response.status });
    return null;
  }
  const body = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const record = body.data;
  if (!record || typeof record !== 'object') {
    logLookup('generation_record_missing', { bodyKeys: Object.keys(body).slice(0, 12) });
    return null;
  }
  const data = record as GenerationRecord;
  const actualModel = typeof data.model === 'string' ? data.model : '';
  const actualProvider = typeof data.provider_name === 'string' ? data.provider_name : '';
  if (!actualModel || !actualProvider || data.is_byok !== false) {
    logLookup('generation_record_identity_invalid', {
      recordKeys: Object.keys(data).slice(0, 16),
      modelPresent: Boolean(actualModel),
      providerPresent: Boolean(actualProvider),
      isByokType: typeof data.is_byok,
      isByokFalse: data.is_byok === false,
    });
    return null;
  }
  const allowedProvider = [input.snapshot.providerBaseSlug, input.snapshot.providerEndpointSlug]
    .some((value) => value.toLowerCase() === actualProvider.toLowerCase());
  if (!allowedProvider) {
    logLookup('generation_record_provider_mismatch', { providerPresent: true });
    return null;
  }
  if (![input.snapshot.requestedModel, input.snapshot.canonicalModel, input.snapshot.providerModel].includes(actualModel)) {
    logLookup('generation_record_model_mismatch', { modelPresent: true });
    return null;
  }
  const usageCost = typeof data.usage === 'object' && data.usage !== null
    ? numericZero((data.usage as Record<string, unknown>).cost)
    : numericZero(data.usage);
  const reportedCost = numericZero(data.total_cost) ?? usageCost;
  if (reportedCost === null || reportedCost !== 0) {
    logLookup('generation_record_cost_invalid', {
      totalCostType: typeof data.total_cost,
      usageType: typeof data.usage,
      usageObjectKeys: data.usage && typeof data.usage === 'object' ? Object.keys(data.usage as Record<string, unknown>).slice(0, 12) : [],
    });
    return null;
  }
  logLookup('generation_record_recovered', { modelPresent: true, providerPresent: true });
  return {
    actualModel,
    actualProvider,
    byok: false,
    // provider.only + allow_fallbacks=false means the successful generation
    // could only have used the one pinned provider endpoint.
    attempt: 1,
    reportedCost,
    costVerification: 'ZERO',
  };
}

function constrainedRoutingAudit(snapshot: ApprovedEndpointSnapshot, payload: Record<string, unknown>): RoutingAudit | null {
  // The chat-completions generation endpoint can legitimately return 404 for
  // a completed free multimodal generation even though the request itself
  // used a pinned provider. In that case the request contract still gives us
  // a bounded audit: exact approved model, provider.only + allow_fallbacks=0,
  // and an explicit zero usage cost. Never infer this when any of those
  // constraints are missing.
  const actualModel = typeof payload.model === 'string' ? payload.model : '';
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage as Record<string, unknown> : null;
  const reportedCost = numericZero(usage?.cost);
  const allowedModel = [snapshot.requestedModel, snapshot.canonicalModel, snapshot.providerModel].includes(actualModel);
  if (!allowedModel || reportedCost !== 0) {
    console.log(JSON.stringify({
      event: 'ai_router_metadata_constraints_rejected',
      payloadKeys: Object.keys(payload).slice(0, 16),
      modelPresent: Boolean(actualModel),
      modelMatches: allowedModel,
      usageType: typeof payload.usage,
      usageKeys: usage ? Object.keys(usage).slice(0, 16) : [],
      usageCostType: typeof usage?.cost,
      usageCostZero: reportedCost === 0,
    }));
    return null;
  }
  console.log(JSON.stringify({
    event: 'ai_router_metadata_inferred_from_constraints',
    model: actualModel,
    providerEndpoint: snapshot.providerEndpointSlug,
    byok: false,
    attempt: 1,
    costVerification: 'ZERO',
  }));
  return {
    actualModel,
    actualProvider: snapshot.providerEndpointSlug,
    byok: false,
    attempt: 1,
    reportedCost,
    costVerification: 'ZERO',
  };
}

function actualEndpoint(metadata: RouterMetadata): string | null {
  const endpoints = Array.isArray(metadata.endpoints) ? metadata.endpoints : metadata.endpoints?.available;
  const endpoint = endpoints?.find((item) => item.selected === true) || endpoints?.at(-1);
  return String(endpoint?.provider_slug || endpoint?.provider || metadata.provider_slug || metadata.provider || '') || null;
}

function validateMetadata(metadata: RouterMetadata | null, snapshot: ApprovedEndpointSnapshot, payload: Record<string, unknown>): RoutingAudit {
  if (!metadata) throw new AiUpstreamError('AI_ROUTER_METADATA_MISSING', 503, true);
  if (metadata.attempt !== 1 || metadata.is_byok !== false) throw new AiUpstreamError('AI_PROVIDER_POLICY_VIOLATION');
  const endpoint = actualEndpoint(metadata);
  const approvedProviders = [snapshot.providerEndpointSlug, snapshot.providerBaseSlug];
  if (!endpoint || !approvedProviders.some((value) => value.toLowerCase() === endpoint.toLowerCase())) throw new AiUpstreamError('AI_PROVIDER_POLICY_VIOLATION');
  const actualModel = String(payload.model || metadata.model || '');
  if (actualModel && ![snapshot.requestedModel, snapshot.canonicalModel, snapshot.providerModel].includes(actualModel)) throw new AiUpstreamError('AI_MODEL_POLICY_VIOLATION');
  for (const stage of metadata.pipeline || []) {
    const type = String(stage.type || stage.name || 'unknown').toLowerCase().replaceAll('-', '_');
    if (['context_compression', 'server_tools', 'web_search', 'file_parser', 'response_healing'].includes(type)) throw new AiUpstreamError('AI_ROUTER_PIPELINE_VIOLATION');
  }
  const usage = payload.usage as Record<string, unknown> | undefined;
  const reportedCost = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null;
  // A missing or nonnumeric cost is not evidence of a zero-cost response.
  // Fail closed rather than returning an answer that cannot satisfy the
  // production no-cost policy.
  if (reportedCost === null || reportedCost !== 0) throw new AiUpstreamError('AI_BILLING_POLICY_VIOLATION');
  return {
    actualModel: actualModel || snapshot.requestedModel,
    actualProvider: endpoint,
    byok: false,
    attempt: 1,
    reportedCost,
    costVerification: 'ZERO',
  };
}

export async function callOpenRouter(input: {
  env: Env; key: ModelKey; snapshot: ApprovedEndpointSnapshot; privacyClass: PrivacyClass;
  question: string; contextJson: string; images: MaterializedImage[]; timeoutMs: number; signal: AbortSignal;
  requestId?: string; compact?: boolean; maxTokens?: number;
}): Promise<{ answer: ModelAnswer; routingAudit: RoutingAudit; generationId: string | null }> {
  if (!input.env.OPENROUTER_API_KEY?.trim()) throw new AiUpstreamError('AI_PROVIDER_CONFIGURATION_MISSING');
  let images = [...input.images];
  let serialized = '';
  while (true) {
    serialized = JSON.stringify(requestBody(input.key, input.snapshot, input.privacyClass, input.question, input.contextJson, images, input.compact === true, input.maxTokens));
    if (new TextEncoder().encode(serialized).byteLength <= AI_LIMITS.upstreamBodyBytes) break;
    if (!images.length) throw new AiUpstreamError('AI_INPUT_TOO_LARGE', 413, true);
    images.pop();
  }
  // A required visual request will eventually surface this as insufficient
  // media; an optional visual request may continue through the text fallback
  // chain when the image payload cannot fit the provider body limit.
  if (input.images.length && !images.length) throw new AiUpstreamError('MEDIA_NOT_AVAILABLE', 503, true);
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const requestStartedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Metadata': 'enabled',
        'X-OpenRouter-Cache': 'false',
        'HTTP-Referer': input.env.BETTER_AUTH_URL || 'https://connect.invalid',
        'X-OpenRouter-Title': 'Connect Ask AI',
      },
      body: serialized,
      signal: AbortSignal.any([input.signal, timeout]),
    });
  } catch (cause) {
    console.log(JSON.stringify({
      event: 'ai_openrouter_timing',
      requestId: input.requestId,
      model: input.key,
      compact: input.compact === true,
      phase: 'headers',
      headersMs: null,
      bodyReadMs: null,
      totalMs: Date.now() - requestStartedAt,
      firstTokenMs: null,
      status: null,
      responseBytes: 0,
      error: cause instanceof Error ? cause.name : 'unknown',
    }));
    if (timeout.aborted && !input.signal.aborted) throw new AiUpstreamError('MODEL_TIMEOUT', 504, true);
    if (input.signal.aborted) throw new AiUpstreamError('GENERATION_ABORTED', 499);
    // A transport failure is scoped to this endpoint. The executor can move
    // to the next approved endpoint once, but never retry this one forever.
    throw new AiUpstreamError('OPENROUTER_TRANSPORT_FAILURE', 503, true);
  }
  const headersMs = Date.now() - requestStartedAt;
  const bodyStartedAt = Date.now();
  let rawBody: string;
  try {
    rawBody = await response.text();
    console.log(JSON.stringify({
      event: 'ai_openrouter_timing',
      requestId: input.requestId,
      model: input.key,
      compact: input.compact === true,
      phase: 'complete',
      headersMs,
      bodyReadMs: Date.now() - bodyStartedAt,
      totalMs: Date.now() - requestStartedAt,
      firstTokenMs: null,
      status: response.status,
      responseBytes: new TextEncoder().encode(rawBody).byteLength,
    }));
  } catch (cause) {
    console.log(JSON.stringify({
      event: 'ai_openrouter_timing',
      requestId: input.requestId,
      model: input.key,
      compact: input.compact === true,
      phase: 'body',
      headersMs,
      bodyReadMs: Date.now() - bodyStartedAt,
      totalMs: Date.now() - requestStartedAt,
      firstTokenMs: null,
      status: response.status,
      responseBytes: 0,
      error: cause instanceof Error ? cause.name : 'unknown',
    }));
    if (timeout.aborted && !input.signal.aborted) {
      console.log(JSON.stringify({
        event: 'ai_openrouter_response_body_timeout',
        status: response.status,
        contentType: response.headers.get('content-type'),
      }));
      throw new AiUpstreamError('MODEL_TIMEOUT', 504, true);
    }
    if (input.signal.aborted) throw new AiUpstreamError('GENERATION_ABORTED', 499);
    console.log(JSON.stringify({
      event: 'ai_openrouter_response_body_read_failed',
      status: response.status,
      contentType: response.headers.get('content-type'),
      error: cause instanceof Error ? cause.name : 'unknown',
      errorCode: cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code?: unknown }).code).slice(0, 32) : undefined,
    }));
    throw new AiUpstreamError('OPENROUTER_INVALID_RESPONSE', 503, true);
  }
  const payload = parseOpenRouterResponse(rawBody);
  if (!payload) {
    console.log(JSON.stringify({
      event: 'ai_openrouter_response_invalid',
      status: response.status,
      contentType: response.headers.get('content-type'),
      contentLength: rawBody.length,
      shape: responseShape(rawBody, response.headers.get('content-type')),
    }));
    if (response.ok) throw new AiUpstreamError('OPENROUTER_INVALID_RESPONSE', 503, true);
  }
  const body = payload || {};
  const generationId = typeof body.id === 'string' ? body.id : response.headers.get('x-generation-id');
  const metadata = metadataFrom(response, body);
  if (!response.ok) {
    const providerAttempted = metadata?.attempt === 1 && actualEndpoint(metadata) === input.snapshot.providerEndpointSlug;
    const diagnostic = upstreamDiagnostic(body);
    if (response.status === 401) throw new AiUpstreamError('OPENROUTER_UNAUTHORIZED', 502, false, undefined, diagnostic);
    if (response.status === 402) throw new AiUpstreamError('OPENROUTER_PAYMENT_REQUIRED', 503, false, undefined, diagnostic);
    if (response.status === 403) throw new AiUpstreamError('OPENROUTER_FORBIDDEN', 502, false, undefined, diagnostic);
    if (response.status === 429) throw new AiUpstreamError('OPENROUTER_RATE_LIMIT', 429, true, retryAfterSeconds(response.headers.get('retry-after')) || 60, diagnostic);
    if ([408, 504].includes(response.status)) throw new AiUpstreamError('OPENROUTER_TIMEOUT', 504, true, undefined, diagnostic);
    if (response.status >= 500) throw new AiUpstreamError('OPENROUTER_SERVER_ERROR', 503, true, undefined, diagnostic);
    const errorText = JSON.stringify(body).toLowerCase();
    if ([400, 422].includes(response.status) && providerAttempted && /(unsupported|not supported).*(image|parameter)|(image|parameter).*(unsupported|not supported)/.test(errorText)) throw new AiUpstreamError('CAPABILITY_MISMATCH', 503, true, undefined, diagnostic);
    if ([408, 502, 503, 504, 529].includes(response.status) && providerAttempted) throw new AiUpstreamError('PROVIDER_TRANSIENT', 503, true, undefined, diagnostic);
    if (metadata?.attempt === 0) throw new AiUpstreamError('NO_ELIGIBLE_ENDPOINT', 503, true, undefined, diagnostic);
    throw new AiUpstreamError('AI_PROVIDER_UNAVAILABLE', 503, true, undefined, diagnostic);
  }
  const routingAudit = metadata
    ? validateMetadata(metadata, input.snapshot, body)
    : await metadataFromGenerationRecord({ env: input.env, generationId, snapshot: input.snapshot, signal: input.signal })
      .then((audit) => audit || constrainedRoutingAudit(input.snapshot, body)
        || (() => { throw new AiUpstreamError('AI_ROUTER_METADATA_MISSING', 503, true); })());
  const choices = body.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (message?.refusal || choices?.[0]?.finish_reason === 'content_filter') throw new AiUpstreamError('AI_SAFETY_REFUSAL', 422);
  const rawContent = message?.content;
  const content = assistantContentText(rawContent);
  const finishReason = typeof choices?.[0]?.finish_reason === 'string' ? choices[0].finish_reason : undefined;
  const parsed = parseJsonAnswer(content);
  if (parsed === null) {
    modelOutputDiagnostic(input.key, rawContent, parsed, response, finishReason);
    const plainText = content.trim();
    // Some approved vision endpoints return a normal assistant sentence even
    // when the request asks for JSON. A completed, non-empty response is
    // still useful if it passes the executor's output-risk and grounding
    // checks. Adapt only a bounded `stop` response; truncated/empty/error
    // responses remain fail-closed and eligible for the normal finite
    // fallback chain. This is deliberately logged as an adapter event so a
    // provider contract regression is observable rather than swallowed.
    if (finishReason === 'stop' && plainText) {
      const incompleteReason = incompleteAnswerReason(plainText);
      if (incompleteReason) throw rejectIncompleteAnswer(input, plainText, finishReason, incompleteReason);
      const answer = [...plainText].slice(0, AI_LIMITS.answerChars).join('');
      requireQuestionLanguage(input, answer, finishReason);
      console.log(JSON.stringify({
        event: 'ai_model_output_adapted',
        model: input.key,
        format: 'plain_text_stop',
        contentLength: plainText.length,
        answerLength: answer.length,
        bodyLogged: false,
        piiLogged: false,
      }));
      return {
        answer: { answer, citedRefs: [], insufficientContext: false },
        routingAudit,
        generationId: typeof body.id === 'string' ? body.id : null,
      };
    }
    throw new AiUpstreamError('MODEL_OUTPUT_MALFORMED', 503, true, undefined, undefined, finishReason);
  }
  const validated = modelAnswerSchema.safeParse(parsed);
  if (!validated.success) {
    modelOutputDiagnostic(input.key, rawContent, parsed, response, finishReason);
    throw new AiUpstreamError('MODEL_OUTPUT_MALFORMED', 503, true, undefined, undefined, finishReason);
  }
  if (!validated.data.insufficientContext) {
    const incompleteReason = incompleteAnswerReason(validated.data.answer);
    if (incompleteReason) throw rejectIncompleteAnswer(input, validated.data.answer, finishReason, incompleteReason);
  }
  if (validated.data.answer.trim()) requireQuestionLanguage(input, validated.data.answer, finishReason);
  return {
    answer: { ...validated.data, citedRefs: [...new Set(validated.data.citedRefs)], usedMediaRefs: validated.data.usedMediaRefs ? [...new Set(validated.data.usedMediaRefs)] : undefined },
    routingAudit,
    generationId: typeof body.id === 'string' ? body.id : null,
  };
}
