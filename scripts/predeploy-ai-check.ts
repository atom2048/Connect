type Endpoint = Record<string, unknown>;
export {};

const modelPolicy = JSON.parse(process.env.CONNECT_AI_ENDPOINT_POLICY || '{}') as Record<string, { model: string; endpointSlug: string; requireZdr?: boolean }>;
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
if (!Object.keys(modelPolicy).length) throw new Error('CONNECT_AI_ENDPOINT_POLICY JSON is required');

const allowedPricing = new Set(['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write']);
const artifact: Record<string, unknown> = { verifiedAt: new Date().toISOString(), models: {} };

for (const [key, policy] of Object.entries(modelPolicy)) {
  if (!policy.model.endsWith(':free')) throw new Error(`${key}: model must end in :free`);
  const [author, ...slugParts] = policy.model.split('/');
  const slug = slugParts.join('/');
  const response = await fetch(`https://openrouter.ai/api/v1/models/${author}/${slug}/endpoints`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`${key}: endpoint API ${response.status}`);
  const payload = await response.json() as { data?: { endpoints?: Endpoint[] } };
  const endpoints = payload.data?.endpoints || [];
  const endpoint = endpoints.find((candidate) => String(candidate.provider_slug || candidate.name || '') === policy.endpointSlug);
  if (!endpoint) throw new Error(`${key}: exact endpoint ${policy.endpointSlug} missing`);
  const pricing = (endpoint.pricing || {}) as Record<string, string | null>;
  for (const required of ['prompt', 'completion']) if (!(required in pricing) || pricing[required] === null || Number(pricing[required]) !== 0) throw new Error(`${key}: ${required} pricing must be explicit zero`);
  for (const [sku, value] of Object.entries(pricing)) {
    if (!allowedPricing.has(sku)) throw new Error(`${key}: unknown pricing SKU ${sku}`);
    if (value !== null && Number(value) !== 0) throw new Error(`${key}: non-zero ${sku} pricing`);
  }
  const training = Boolean(endpoint.data_policy && (endpoint.data_policy as Record<string, unknown>).training);
  if (training) throw new Error(`${key}: training-enabled endpoint`);
  const zdr = Boolean(endpoint.data_policy && (endpoint.data_policy as Record<string, unknown>).zdr);
  if (policy.requireZdr && !zdr) throw new Error(`${key}: ZDR required`);
  (artifact.models as Record<string, unknown>)[key] = { model: policy.model, endpoint: policy.endpointSlug, training: false, zdr, pricing, verifiedAt: artifact.verifiedAt };
}

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
